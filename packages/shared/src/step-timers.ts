/**
 * A length of time mentioned in a step, and where in the step it was written.
 *
 * The span is what lets the cook screen turn just that phrase into a tappable timer instead of
 * decorating the whole step.
 */
export interface StepDuration {
  /** Total length in seconds. */
  seconds: number;
  /** Index of the first character of the phrase in the step text. */
  start: number;
  /** Index one past the last character of the phrase. */
  end: number;
}

/**
 * The unit words this parser accepts, and what one of each is worth in seconds.
 *
 * The value doubles as the unit's size, which is what decides whether two adjacent phrases are
 * one duration: `1 hour 10 min` continues into a smaller unit, `10 minutes 20 minutes` does not.
 *
 * Single-letter forms (`h`, `m`, `s`) are deliberately absent. A step that says `2 m` is far
 * more likely to be an amount than two minutes, and an unrecognised phrase costs the cook a
 * timer they can still start by hand, where a wrong one runs silently for the wrong length.
 */
const UNIT_SECONDS: Record<string, number> = {
  hour: 3600,
  hours: 3600,
  hr: 3600,
  hrs: 3600,
  minute: 60,
  minutes: 60,
  min: 60,
  mins: 60,
  second: 1,
  seconds: 1,
  sec: 1,
  secs: 1,
};

/** The alternation the pattern below matches a unit with. Order does not matter: the trailing
 *  `\b` is what stops `minute` from matching inside `minutes`. */
const UNIT_WORDS = Object.keys(UNIT_SECONDS).join('|');

const NUMBER = String.raw`\d+(?:\.\d+)?`;

/**
 * One `<amount><unit>` phrase: a number, optionally the high end of a range, then a unit word.
 *
 * A unit is required, which is the whole guard against temperatures (`350F`), ordinals
 * (`step 3`) and quantities (`2 cups`): none of them is followed by a time word.
 */
const COMPONENT = new RegExp(
  // `(?<![\d.])` starts a match only at the beginning of a number. Without it every digit of a
  // long run starts a fresh attempt, which is quadratic, and imported steps are untrusted text.
  String.raw`(?<![\d.])(${NUMBER})(?:(?:\s*[-–—]\s*|\s+to\s+)(${NUMBER}))?\s*[-–—]?\s*(${UNIT_WORDS})\b`,
  'gi',
);

/**
 * What may sit between two phrases of the same duration: whitespace, a comma, or "and".
 *
 * Anything else - a word, a full stop - makes them two separate durations, so
 * `Bake 20 minutes. Rest 10 minutes.` is two timers rather than one 30-minute one.
 */
const COMPOUND_GAP = /^[\s,]*(?:and\s+)?$/;

/**
 * What separates the two ends of a range whose bounds carry their own units.
 *
 * `20 to 30 minutes` is one match of COMPONENT and never reaches this. `45 minutes to 1 hour`
 * cannot be, because the bounds are in different units, so it arrives as two durations that
 * this collapses back into one.
 */
const RANGE_GAP = /^\s*(?:to|[-–—])\s*$/;

/**
 * The longest a parsed phrase may be before it stops looking like a kitchen timer.
 *
 * Guards a typo, not a recipe: a 24-hour brine or proof is real, `100000000 minutes` is not,
 * and offering it as a tappable timer would put a six-digit clock in the tray.
 */
const MAX_TIMER_SECONDS = 24 * 3600;

/** True when a match starts partway through a longer token, e.g. the `2` of `1/2`. */
function startsInsideAnotherToken(text: string, start: number): boolean {
  if (start === 0) return false;
  const before = text[start - 1] ?? '';
  return /[\w./]/.test(before);
}

/**
 * Every NUMERIC duration mentioned in a step, in the order they appear.
 *
 * Ranges resolve to their LONGER bound, whether both ends share a unit (`5-10 minutes`) or
 * carry their own (`45 minutes to 1 hour`): a timer that fires early sends the cook back to a
 * pan that is not ready, which is worse than one that fires late.
 *
 * Known gaps, all of which return no duration rather than a wrong one, because a phrase that
 * stays plain text costs the cook one hand-set timer and a wrong span costs them the dish:
 * fractions (`1/2 hour`, `1½ hours`), amounts written as words (`half an hour`, `a few
 * minutes`), and open-ended waits (`overnight`).
 */
export function findStepDurations(text: string): StepDuration[] {
  const durations: StepDuration[] = [];
  // The duration a following smaller unit would continue, and how big that unit was. Null
  // whenever the previous phrase cannot be continued, which keeps a skipped phrase from
  // silently attaching the next one to a duration two sentences back.
  let open: { duration: StepDuration; unitSeconds: number } | null = null;

  COMPONENT.lastIndex = 0;
  for (let match = COMPONENT.exec(text); match !== null; match = COMPONENT.exec(text)) {
    const start = match.index;
    const end = start + match[0].length;
    if (startsInsideAnotherToken(text, start)) {
      open = null;
      continue;
    }

    const unitSeconds = UNIT_SECONDS[(match[3] ?? '').toLowerCase()] ?? 0;
    // A range takes its high end; a lone amount is its own high end.
    const low = Number(match[1]);
    const high = match[2] === undefined ? low : Number(match[2]);
    const phraseSeconds = Math.max(low, high) * unitSeconds;

    if (
      open !== null &&
      unitSeconds < open.unitSeconds &&
      COMPOUND_GAP.test(text.slice(open.duration.end, start))
    ) {
      open.duration.seconds = Math.round(open.duration.seconds + phraseSeconds);
      open.duration.end = end;
      open.unitSeconds = unitSeconds;
    } else if (phraseSeconds > 0) {
      const duration: StepDuration = { seconds: Math.round(phraseSeconds), start, end };
      durations.push(duration);
      open = { duration, unitSeconds };
    } else {
      open = null;
    }
  }

  return collapseRanges(durations, text).filter(
    (duration) => duration.seconds <= MAX_TIMER_SECONDS,
  );
}

/**
 * Join `45 minutes to 1 hour` back into one duration at its longer bound.
 *
 * Runs after the scan rather than inside it because the two bounds are two complete phrases
 * with their own units, which is exactly what the compound rule refuses to merge.
 */
function collapseRanges(durations: StepDuration[], text: string): StepDuration[] {
  const collapsed: StepDuration[] = [];
  for (const duration of durations) {
    const previous = collapsed[collapsed.length - 1];
    if (previous !== undefined && RANGE_GAP.test(text.slice(previous.end, duration.start))) {
      previous.seconds = Math.max(previous.seconds, duration.seconds);
      previous.end = duration.end;
      continue;
    }
    collapsed.push(duration);
  }
  return collapsed;
}
