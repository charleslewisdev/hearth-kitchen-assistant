import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../env';

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL });
export const db = drizzle(pool);
export type DB = typeof db;
