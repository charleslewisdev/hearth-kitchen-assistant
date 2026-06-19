import { pool } from '../src/db/client';

let n = 0;
// Insert a minimal organization row directly; returns its id (the household id).
// Column names match the generated auth-schema: `created_at` (snake_case, no default).
export async function createHousehold(): Promise<string> {
  const id = `hh_${++n}_${Date.now()}`;
  await pool.query(
    `insert into "organization" (id, name, slug, created_at) values ($1, $2, $3, now())`,
    [id, `House ${n}`, `house-${n}-${Date.now()}`],
  );
  return id;
}
