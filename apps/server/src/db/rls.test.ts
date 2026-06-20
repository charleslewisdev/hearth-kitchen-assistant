import { describe, it, expect } from 'vitest';
import { pool } from './client';

// Tenant-isolation discipline guard (deferred backlog #5).
//
// Decision 31 makes Postgres RLS load-bearing, but applying it is currently
// *convention*: every migration that adds a domain table carrying `household_id`
// must by hand (a) ENABLE + FORCE row-level security, (b) add at least one policy,
// and (c) GRANT DML to the unprivileged `hearth_app` role the repo layer SETs into
// (see drizzle/0001_rls_recipes.sql). The moment a future migration adds a
// `household_id` table and forgets that boilerplate, the table silently bypasses
// isolation. This test turns the convention into an assertion so that can't happen
// quietly — it fails the build instead.
describe('tenant-isolation discipline (RLS coverage)', () => {
  it('every household_id table enables+forces RLS, has a policy, and grants hearth_app DML', async () => {
    const { rows } = await pool.query<{
      table: string;
      rls_enabled: boolean;
      rls_forced: boolean;
      policy_count: string; // count() returns bigint -> string over the wire
      app_select: boolean;
      app_insert: boolean;
      app_update: boolean;
      app_delete: boolean;
    }>(`
      select
        c.relname as table,
        c.relrowsecurity as rls_enabled,
        c.relforcerowsecurity as rls_forced,
        (select count(*) from pg_policy p where p.polrelid = c.oid) as policy_count,
        has_table_privilege('hearth_app', c.oid, 'SELECT') as app_select,
        has_table_privilege('hearth_app', c.oid, 'INSERT') as app_insert,
        has_table_privilege('hearth_app', c.oid, 'UPDATE') as app_update,
        has_table_privilege('hearth_app', c.oid, 'DELETE') as app_delete
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind = 'r'
        and exists (
          select 1 from pg_attribute a
          where a.attrelid = c.oid
            and a.attname = 'household_id'
            and not a.attisdropped
        )
      order by c.relname;
    `);

    // Sanity: the introspection itself found something (recipes carries
    // household_id today). Without this, a query that returned zero rows would pass
    // vacuously and hide the very regression this test exists to catch.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.table)).toContain('recipes');

    const offenders = rows
      .filter(
        (r) =>
          !r.rls_enabled ||
          !r.rls_forced ||
          Number(r.policy_count) < 1 ||
          !r.app_select ||
          !r.app_insert ||
          !r.app_update ||
          !r.app_delete,
      )
      .map((r) => r.table);

    expect(
      offenders,
      `tables with household_id missing RLS/policy/grant: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
