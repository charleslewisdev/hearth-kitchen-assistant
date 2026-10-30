-- Custom SQL migration file, put your code below! --
-- A MEMBERSHIP THAT ENDS TAKES THE HOUSEHOLD OFF THAT PERSON'S SESSIONS.
--
-- The fourth time in this milestone that a rule turned out to be enforced somewhere a second
-- road went around, and the one that was actually reachable in ordinary use. `activeOrganizationId`
-- is a column on the SESSION: `protectedProcedure` derives `ctx.householdId` from it and the RLS
-- policies compare against the same value, so it is what opens the recipes and the shopping list.
-- Better Auth clears it only when a user removes THEMSELVES (`crud-members.mjs`), and only on the
-- session that made that request. So an owner removing anyone else left a live session still
-- naming the household, for the seven days until it expired. Measured before this existed:
-- `recipe.list` returned the household's recipes to someone who had been removed from it.
--
-- WHY THIS IS NOT IN THE ROUTER. `household.removeMember` is one of four ways a `member` row
-- goes: `/organization/remove-member` and `/organization/leave` are mounted at `/api/auth/*` and
-- reach the delete without any of this app's code running, deleting a household cascades to its
-- members, and `leave` clears only the session it was called on - a phone and a laptop are two
-- rows, and it clears one. A revocation in the router would hold for one of those four.
--
-- WHY IT IS NOT TWO WRITES. Doing this after the delete, anywhere, is a second statement that can
-- fail on its own, and a failed second statement leaves the membership gone and the session still
-- naming the household: the hole again, silently, with the removal reported as a success. A
-- trigger runs inside the statement that fired it, so there is no second write to fail and no
-- window to be interrupted in. Roll the delete back and the session comes back with it.
--
-- WHAT IT CLEARS, AND WHAT IT LEAVES. Only sessions of the person who left, and only those naming
-- the household they left. A session pointing at some other household is not stale, and a session
-- pointing at nothing is already harmless - `protectedProcedure` refuses it, `/organization/create`
-- is capped, and `/organization/set-active` re-derives membership before it will point one
-- anywhere. That last fact is what makes clearing the column a revocation rather than a hint.
--
-- AND WHY THE ROW SURVIVES. The alternative is deleting the session, which revokes the account's
-- authentication rather than its access to a household, and those are different things: being
-- removed from the household is not being signed out of Hearth. The web app already has the
-- screen for an account with no household (`<Onboarding />`) and a route outside the session gate
-- for one that has been invited back (`/accept-invite/:id`), so leaving the row is what keeps the
-- way back open. It also keeps this trigger from writing underneath Better Auth: on the
-- self-removal path it goes on to call `setActiveOrganization(token, null)`, which would be an
-- update against a row this had deleted, and which is instead a no-op writing null over null.
--
-- IMMEDIATE, where `member_keeps_an_owner` (0005) is deferred. That one is a CHECK and has to
-- wait: for the household row to be gone before it can tell a cascade from an emptying, and for
-- other transactions to commit before it can count owners. This is a WRITE that accompanies the
-- delete. It has nothing to wait for, it takes no lock of its own beyond the rows it updates, and
-- running it at the statement keeps the window between the two facts at zero.
--
-- DELETE only, not UPDATE. 0005 covers UPDATE because demoting the last owner empties a household
-- of owners without removing anybody; there is no such move here. A role change does not end a
-- membership, and nothing in this application or in Better Auth ever moves a `member` row between
-- households. If something ever does, this needs the UPDATE branch too.
--
-- `updated_at` is deliberately left alone. Better Auth compares it against `updateAge` to decide
-- when to extend a session's expiry, so touching it here would quietly buy the session more life
-- on its next request - the opposite of the point.

CREATE OR REPLACE FUNCTION hearth_member_loses_the_household() RETURNS trigger AS $$
BEGIN
  UPDATE "session"
     SET active_organization_id = NULL
   WHERE user_id = OLD.user_id
     AND active_organization_id = OLD.organization_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER member_loses_the_household
  AFTER DELETE ON "member"
  FOR EACH ROW EXECUTE FUNCTION hearth_member_loses_the_household();
--> statement-breakpoint
-- And the rows that are already wrong. The trigger only fires on a later write, so an instance
-- where someone was removed before this migration would keep serving them until their session
-- expired - the same hole, left open by the thing that was supposed to shut it, which is the
-- shape this milestone keeps finding. Making the invariant true is part of the migration's job,
-- not an instruction left for an operator to carry out.
--
-- The predicate is the trigger's, generalised from one membership to all of them: a session
-- naming a household its user is not a member of. There is no legitimate row like that -
-- `/organization/set-active` re-derives membership before it will point a session anywhere, and
-- the session-create hook reads the membership - so this is a no-op on an instance that never
-- removed anyone, which is every instance that installs Hearth for the first time. That is also
-- why the suite does not cover this statement: migrations run before the tests, against an empty
-- database. What the tests cover is the trigger, which is what holds the rule from here on.
UPDATE "session" s
   SET active_organization_id = NULL
 WHERE s.active_organization_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "member" m
      WHERE m.user_id = s.user_id
        AND m.organization_id = s.active_organization_id
   );
