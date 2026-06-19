import { pool } from '../src/db/client';

// Truncate all app tables between test runs. Order respects FKs via CASCADE.
export async function resetDb(): Promise<void> {
  await pool.query(`
    truncate table recipes, "member", "invitation", "organization",
      "session", "account", "verification", "user" restart identity cascade;
  `);
}
