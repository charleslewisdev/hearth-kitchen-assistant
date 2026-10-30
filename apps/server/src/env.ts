import { isIP } from 'node:net';
import { z } from 'zod';

/**
 * Container platforms have no way to say "unset": `${VAR:-}` in a compose file and an untouched
 * field in an unraid template both arrive as the empty string, and a field an operator cleared
 * by hand often keeps a space. Left alone that is worse than a missing value, because it passes
 * AS a value: `z.coerce.number()` reads '' as 0, and a DATA_DIR of '' resolves against the
 * working directory. So blank means absent, and the default or the `.optional()` behind this
 * decides what happens next.
 *
 * Whitespace-only counts as blank; a value with whitespace around it does not, because trimming
 * a real value would be a different decision made silently. Applied to every variable that has
 * a default or is optional - a required one blank is a missing one, and fails on its own.
 */
const blankIsAbsent = (v: unknown): unknown =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

/**
 * The From address a deployment gets when it sets none.
 *
 * It lives here, with the schema that applies it, rather than in mail/mailer.ts. The other
 * direction was tried first and pointed the wrong way: env.ts is imported by almost everything,
 * so importing the mail module from it pulled nodemailer into every process and every test that
 * merely reads configuration, and made configuration depend on a feature.
 *
 * Exporting it lets mailer.ts recognise the value it is warning about. It does NOT keep
 * `.env.example` in step - that file restates the address as prose and can still drift, exactly
 * as the `DEV_AUTH_SECRET` line there can. A TypeScript export cannot bind a comment in a
 * dotfile, and claiming otherwise is how the drift goes unnoticed.
 *
 * Kept as `hearth@localhost` despite not being routable: in console mode, the zero-config path
 * this default exists for, no envelope is ever built. Once SMTP is configured it is usually
 * wrong, because a relay wants a MAIL FROM on a domain it is authorised for, so createMailer
 * warns about it at boot rather than letting it fail as a 5xx inside the relay.
 */
export const DEFAULT_SMTP_FROM = 'hearth@localhost';

/**
 * The words an operator may write for a boolean, and the reason `z.coerce.boolean()` is not
 * used for one.
 *
 * `z.coerce.boolean()` is `Boolean(value)`. Every non-empty string is therefore `true`, so
 * `SMTP_SECURE=false` would mean implicit TLS, on a port that expects STARTTLS, configured by
 * someone who wrote the word "false" and was ignored. `'0'` and `'no'` behave the same way.
 *
 * Arrays rather than a lookup object on purpose: `words['constructor']` on a plain object
 * answers with `Object.prototype.constructor`, which is not undefined and would be handed back
 * as the parsed value.
 */
const TRUE_WORDS = ['true', '1', 'yes', 'on'];
const FALSE_WORDS = ['false', '0', 'no', 'off'];

/**
 * A boolean read from the environment, defaulting when absent and REFUSING a word it does not
 * know rather than guessing at it.
 *
 * Refusing matters more than the parse table does. A guess has two ways to be wrong and only
 * one of them is loud: reading an "on" word as false is what quietly downgrades a connection
 * that was meant to be encrypted, and nothing downstream would report it.
 */
function envBoolean(fallback: boolean) {
  return z.preprocess(
    blankIsAbsent,
    z
      .union([z.boolean(), z.string()])
      .default(fallback)
      .transform((value, ctx) => {
        if (typeof value === 'boolean') return value;
        const word = value.trim().toLowerCase();
        if (TRUE_WORDS.includes(word)) return true;
        if (FALSE_WORDS.includes(word)) return false;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `expected one of ${[...TRUE_WORDS, ...FALSE_WORDS].join(', ')}`,
        });
        return z.NEVER;
      }),
  );
}

/** One address or CIDR range in TRUST_PROXY: `192.168.1.1`, `10.0.0.0/8`, `fd00::/8`. */
function isAddressOrRange(entry: string): boolean {
  const [address, bits, extra] = entry.split('/');
  if (extra !== undefined || !address || isIP(address) === 0) return false;
  if (bits === undefined) return true;
  if (!/^\d{1,3}$/.test(bits)) return false;
  return Number(bits) <= (isIP(address) === 4 ? 32 : 128);
}

/** A hop count, or a list of trusted proxy addresses. See TRUST_PROXY below. */
export const trustProxySchema = z.union([
  z.coerce.number().int().min(0),
  z
    .string()
    .max(1000)
    .transform((value) => value.split(',').map((entry) => entry.trim()).filter(Boolean))
    .refine((list) => list.length > 0 && list.every(isAddressOrRange), {
      message: 'TRUST_PROXY must be a hop count or a comma-separated list of addresses or CIDRs',
    }),
]);

export const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .url()
    // The placeholder in the unraid template. Left in, it fails later as a bare auth error.
    .refine((url) => !url.includes('CHANGE_ME'), {
      message: 'DATABASE_URL still contains CHANGE_ME: set the real database password',
    }),
  // Optional: unset means "generate one on first boot and keep it in DATA_DIR" (see secret.ts),
  // which is what lets a fresh instance come up with no configuration at all.
  BETTER_AUTH_SECRET: z.preprocess(blankIsAbsent, z.string().min(32).optional()),
  /**
   * The one public identity (D35), and the only origin-shaped value a deployment sets.
   *
   * Optional here rather than required, because `derivePublicConfig` is what decides: it takes
   * `PUBLIC_URL ?? WEB_ORIGIN` and throws a message naming PUBLIC_URL when both are absent.
   * Requiring it in this schema would produce `PUBLIC_URL: Required` for a `pnpm dev` that had
   * set WEB_ORIGIN and was correct to.
   */
  PUBLIC_URL: z.preprocess(blankIsAbsent, z.string().url().optional()),
  /**
   * The old spelling of PUBLIC_URL, kept as its fallback and nothing else.
   *
   * Optional, where it used to be required. It has to stay in the schema because config.ts
   * still reads it, and it has to stop being required because a deployment that follows the
   * PUBLIC_URL-only docs sets neither this nor the `BETTER_AUTH_URL` that used to sit beside
   * it. That one is gone entirely: nothing has read it since D35 made the public identity one
   * value, so an operator who still sets it now has it ignored rather than validated. Zod
   * strips unknown keys, so setting it is harmless; it is simply not configuration any more.
   *
   * The fallback is worth keeping past that. `pnpm dev` puts the browser on the vite server at
   * :5173 and the fixtures in `e2e/` read WEB_ORIGIN for the same address, so dropping it would
   * make every local checkout set a new variable to keep working.
   */
  WEB_ORIGIN: z.preprocess(blankIsAbsent, z.string().url().optional()),
  /**
   * Writable state that outlives a container: the generated auth secret, and the first-boot
   * setup token that claims a fresh instance.
   */
  DATA_DIR: z.preprocess(blankIsAbsent, z.string().default('./.data')),
  /**
   * Whether this instance hosts exactly one household (D36), which is what every part of the
   * app assumes today: invitees join the owner's existing household, so there is one to join.
   *
   * A flag rather than a hardcoded truth because the assumption is load-bearing in three
   * separate places and, left implicit, lifting it later is archaeology rather than a decision.
   * `false` is NOT a supported mode yet - it removes the enforcement, it does not add the
   * multi-tenant surfaces (household switching, per-household invitations) that would make an
   * instance with two households usable. It exists so that P5 is a flag plus a dropped index.
   */
  SINGLE_HOUSEHOLD: envBoolean(true),
  PORT: z.preprocess(blankIsAbsent, z.coerce.number().default(3000)),
  /**
   * Who may vouch for the client's address in X-Forwarded-For. Either a hop count (`1`: one
   * proxy in front) or a comma-separated list of the proxies' own addresses or CIDR ranges
   * (`192.168.1.1`), which is the better choice when the published port is reachable from other
   * machines: a hop count trusts whoever connects, an address trusts only that proxy.
   *
   * Never `true`: that resolves the LEFTMOST entry, which any client can write, handing an
   * attacker the value the rate limiter keys on. The default is 0, trust nobody, so an instance
   * nobody configured cannot be told who its clients are. Behind a proxy that leaves the whole
   * household in one rate-limit bucket until this is set, which fails closed (D46).
   */
  TRUST_PROXY: z.preprocess(blankIsAbsent, trustProxySchema.default(0)),
  /**
   * Where the built web app is, so this process serves it (D46). Unset: `apps/web/dist` beside
   * the server, if it exists. The development setup has no build there and uses Vite instead.
   */
  WEB_DIST_DIR: z.preprocess(blankIsAbsent, z.string().optional()),
  /**
   * SMTP. Unset SMTP_HOST is the whole configuration for a zero-config install: it selects the
   * console mailer, which writes invitation links to the log instead of sending them (see
   * mail/mailer.ts for why that trade is made and what it costs).
   *
   * Every one of these takes blankIsAbsent, and SMTP_HOST is the one it matters most for. An
   * untouched unraid template field arrives as '', and read as a value it would select SMTP
   * against an empty host: mail would stop appearing in the log and never arrive anywhere else.
   */
  SMTP_HOST: z.preprocess(blankIsAbsent, z.string().optional()),
  // Bounded, unlike PORT, because a bad value here surfaces as an obscure failure inside
  // nodemailer at send time rather than as a bind error at boot. 587 is the submission port,
  // which pairs with SMTP_SECURE=false (STARTTLS); 465 is the implicit-TLS one.
  SMTP_PORT: z.preprocess(blankIsAbsent, z.coerce.number().int().min(1).max(65535).default(587)),
  SMTP_USER: z.preprocess(blankIsAbsent, z.string().optional()),
  SMTP_PASS: z.preprocess(blankIsAbsent, z.string().optional()),
  /** Implicit TLS (port 465). False still upgrades via STARTTLS when the relay offers it. */
  SMTP_SECURE: envBoolean(false),
  SMTP_FROM: z.preprocess(blankIsAbsent, z.string().default(DEFAULT_SMTP_FROM)),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

/**
 * Parsed once, at import. That is what makes `envSchema` worth exporting: the schema is the only
 * part a test can exercise, and the rules above are exactly the kind that pass review and then
 * turn out to read an empty string as 0.
 */
export const env = envSchema.parse(process.env);
export type Env = z.infer<typeof envSchema>;
