import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { db } from './db/client';
import { env } from './env';
import {
  user,
  session,
  account,
  verification,
  organization as organizationTable,
  member,
  invitation,
} from './db/auth-schema';

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  // Pass the Drizzle tables explicitly — the adapter cannot infer models otherwise.
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: { user, session, account, verification, organization: organizationTable, member, invitation },
  }),
  emailAndPassword: { enabled: true },
  trustedOrigins: [env.WEB_ORIGIN],
  plugins: [organization()],
});

export type Auth = typeof auth;
