-- Custom SQL migration file, put your code below! --
-- A HOUSEHOLD KEEPS AT LEAST ONE OWNER.
--
-- The third time in this milestone that a check turned out not to be the enforcer, and the
-- same shape as the household cap in 0004: the application reads the owner count and then
-- writes, on separate statements with nothing between them, so two concurrent removals of two
-- different owners both see two owners and both commit. Reproduced against a real server:
-- `race results = [200, 200]`, then `owners remaining = 0, members = 0, organizations = 1`.
--
-- What that leaves is unrecoverable from inside the app, which is why it belongs here rather
-- than in one more place that checks. With no members, `/organization/create` is refused
-- because a household exists, `/organization/invite-member` is refused because the caller is
-- not a member of it, and `/organization/set-active` is refused for the same reason. The
-- household row survives holding every recipe, and the only way back is SQL. That is precisely
-- the state the first-boot setup token exists to prevent (auth-invite.ts), reached by a
-- different door.
--
-- A router check cannot hold this even if it were serialized, because `/organization/leave`
-- and `/organization/remove-member` are mounted at `/api/auth/*` and reach the same delete
-- without passing through the router at all. This runs wherever the row goes.
--
-- THE LOCK IS NOT DECORATION. A deferred constraint trigger runs at COMMIT, which is late
-- enough to see the other transaction's committed delete - but only if the other transaction
-- has committed by then, and two backends can sit inside that window together. Taking the
-- household row FOR UPDATE first makes the second one wait for the first to commit, and its
-- next statement then reads a snapshot that includes the delete. Without it this trigger would
-- be the same check-then-act one layer down.
--
-- ON UPDATE as well as DELETE, because demoting the last owner empties the household of owners
-- without removing anybody. `/organization/update-member-role` is refused at the middleware
-- (D36 has no promotion), and this is what makes that a fact about the data rather than about
-- the one route that happens to be closed.
--
-- The organization lookup is what keeps deleting a household from failing: the cascade removes
-- its members, and by commit time the household is gone, so there is no invariant left to hold.
-- Deferring is what makes that observable - an immediate trigger would fire mid-cascade.

CREATE OR REPLACE FUNCTION hearth_household_keeps_an_owner() RETURNS trigger AS $$
DECLARE
  household_id text := COALESCE(NEW.organization_id, OLD.organization_id);
BEGIN
  PERFORM 1 FROM "organization" WHERE id = household_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "member" WHERE organization_id = household_id AND role = 'owner'
  ) THEN
    -- A user-defined SQLSTATE rather than a generic check violation, so the household router
    -- can tell this apart from any other constraint and answer the loser of a race with the
    -- same sentence the sequential case gets. The message names no user and no household.
    RAISE EXCEPTION 'a household must keep at least one owner' USING ERRCODE = 'HH001';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER member_keeps_an_owner
  AFTER DELETE OR UPDATE ON "member"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION hearth_household_keeps_an_owner();

-- Note for an instance that already has an ownerless household: this migration applies anyway,
-- since the trigger only fires on a later write. That household stays unreachable until someone
-- inserts an owner by hand, which is the same manual recovery it needed before.
