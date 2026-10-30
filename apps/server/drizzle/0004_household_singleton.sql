-- Custom SQL migration file, put your code below! --
-- Two constraints that turn D36's household rules from a check into an invariant.
--
-- 1. ONE HOUSEHOLD PER INSTANCE.
--    `auth-invite.ts` refuses `/organization/create` once a household exists, but that is
--    check-then-act: the read and the insert are separate statements on separate connections
--    with nothing serializing them, so two concurrent requests both read "none" and both
--    insert. Reproduced end to end. A unique index on a constant expression is a singleton
--    constraint - every row indexes the same key, so the second insert loses in the database
--    rather than in application logic. The application check stays for the friendly message;
--    this is the enforcer.
--
--    Dropping this index is exactly half of lifting the cap; the other half is
--    SINGLE_HOUSEHOLD=false, which the three application sites already read.
--
-- 2. NO DUPLICATE MEMBERSHIPS.
--    `member` has indexes on both columns but no uniqueness across the pair, so one user could
--    hold two rows in the same household - reachable when two pending invitations exist for one
--    address, which the invitation flow supports: sign-up auto-accepts the newest and the older
--    emailed link is still clickable. Task 13's member list would show the person twice.

CREATE UNIQUE INDEX organization_singleton_uidx ON "organization" ((true));
--> statement-breakpoint
CREATE UNIQUE INDEX member_organization_user_uidx ON "member" (organization_id, user_id);

-- Note for an instance that somehow already holds two households: this migration will FAIL to
-- apply rather than silently pick a winner, which is the right way round. Merge or delete the
-- extra household first.
