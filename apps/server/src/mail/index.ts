import { env } from '../env';
import { logger, noQuieterThan } from '../log';
import { createMailer } from './mailer';

/**
 * The one mailer this process uses.
 *
 * Built at import, which is also what emits the single startup line naming the transport that
 * was selected: `info` for SMTP, `warn` for the console fallback, because the console fallback
 * puts live invitation links into the log and an operator has to know that before they ship
 * their logs anywhere. Under NODE_ENV=test the shared logger is silent, so the suite stays
 * quiet without this module having to know it is being tested.
 *
 * A singleton rather than a factory call per send: the selection is a property of the
 * deployment, it is announced once, and one transport means one connection pool.
 */
/**
 * The mail logger, floored at `warn`.
 *
 * In console mode the log IS the delivery mechanism, so the level knob and the invite flow are
 * the same knob, which is not a trade an operator should be able to make by accident.
 * `LOG_LEVEL=error` (and `fatal`) emitted neither the link nor the boot warning explaining why:
 * an install that could onboard nobody, with nothing on screen saying so. It also hollowed out
 * the argument against refusing console mode in production (see mailer.ts), which rests on that
 * boot warning being a compensating control - and a control configuration can switch off is not
 * one. A pino child may be MORE verbose than its parent, so this raises the floor without
 * touching the operator's global level.
 *
 * `silent` is honoured rather than overridden, and that is the one deliberate gap. It is the
 * single unambiguous way to say "emit nothing at all", where `error` means "fewer logs" and
 * never means "break invitations"; and it is what keeps the suite quiet, since the shared logger
 * is silent under test (log.ts). `.env.example` states the exception rather than promising
 * around it.
 *
 * A floor, via `noQuieterThan`, and not a fixed `{ level: 'warn' }`. That was the original
 * spelling and it was quieter than the operator asked for as well as louder: a pino child's
 * level REPLACES its parent's, so at `LOG_LEVEL=info` it also suppressed this module's one
 * `info` line - "mail will be delivered over SMTP", the only startup confirmation that a
 * relay's settings were read at all. Verified against a container with SMTP configured: no
 * line. The comment above already described the intended behaviour; only the code disagreed.
 */
const mailLog = logger.child({}, { level: noQuieterThan(logger.level, 'warn') });

export const mailer = createMailer({ env, logger: mailLog });
