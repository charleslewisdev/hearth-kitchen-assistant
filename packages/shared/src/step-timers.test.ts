import { describe, it, expect } from 'vitest';
import { findStepDurations } from './step-timers';

/** The exact phrase each duration covers, so a span assertion reads as text. */
function phrases(text: string): string[] {
  return findStepDurations(text).map((d) => text.slice(d.start, d.end));
}

/** Just the lengths, in seconds. */
function seconds(text: string): number[] {
  return findStepDurations(text).map((d) => d.seconds);
}

describe('findStepDurations', () => {
  it('finds a single duration and spans only the phrase itself', () => {
    const text = 'Simmer for 20 minutes.';
    expect(seconds(text)).toEqual([20 * 60]);
    expect(phrases(text)).toEqual(['20 minutes']);
  });

  it('reads a compound duration as one timer', () => {
    const text = 'Bake 1 hour 10 min, uncovered.';
    expect(seconds(text)).toEqual([70 * 60]);
    expect(phrases(text)).toEqual(['1 hour 10 min']);
  });

  it('joins compound parts written with "and" or a comma', () => {
    expect(seconds('Chill 1 hour and 10 minutes')).toEqual([70 * 60]);
    expect(seconds('Chill 1 hour, 10 minutes')).toEqual([70 * 60]);
  });

  it('takes the LONGER bound of a range, because firing early is worse than late', () => {
    expect(seconds('Let rest 5-10 minutes')).toEqual([10 * 60]);
    expect(seconds('Let rest 5 to 10 minutes')).toEqual([10 * 60]);
    expect(seconds('Let rest 5–10 minutes')).toEqual([10 * 60]); // en dash
    expect(phrases('Let rest 5-10 minutes')).toEqual(['5-10 minutes']);
  });

  it('accepts a hyphenated unit', () => {
    expect(seconds('Give it a 10-minute rest')).toEqual([10 * 60]);
  });

  it('handles hours, minutes and seconds, and their abbreviations', () => {
    expect(seconds('Whisk 30 seconds')).toEqual([30]);
    expect(seconds('Whisk 30 secs')).toEqual([30]);
    expect(seconds('Rest 2 hrs')).toEqual([2 * 3600]);
    expect(seconds('Rest 1 hr 30 sec')).toEqual([3600 + 30]);
    expect(seconds('Chill 1.5 hours')).toEqual([90 * 60]);
    expect(phrases('Chill 1.5 hours')).toEqual(['1.5 hours']);
  });

  it('is case insensitive', () => {
    expect(seconds('BAKE 20 MINUTES')).toEqual([20 * 60]);
    expect(seconds('Chill 1 Hour')).toEqual([3600]);
  });

  it('does not read a temperature as a duration', () => {
    const text = 'Bake at 350F for 20 minutes.';
    expect(seconds(text)).toEqual([20 * 60]);
    expect(phrases(text)).toEqual(['20 minutes']);
  });

  it('does not read an oven temperature written as a bare number', () => {
    expect(seconds('Preheat the oven to 425 and bake 12-15 minutes')).toEqual([15 * 60]);
  });

  it('does not read an ordinal or a step reference as a duration', () => {
    expect(findStepDurations('Repeat step 3 with the remaining dough')).toEqual([]);
    expect(findStepDurations('Return to the pan from step 2')).toEqual([]);
  });

  it('does not read an ingredient quantity as a duration', () => {
    expect(findStepDurations('Add 2 cups flour and 3 tbsp sugar')).toEqual([]);
    expect(findStepDurations('Stir in 250 g butter')).toEqual([]);
  });

  it('keeps separate sentences separate rather than summing them', () => {
    const text = 'Bake 20 minutes. Rest 10 minutes.';
    expect(seconds(text)).toEqual([20 * 60, 10 * 60]);
    expect(phrases(text)).toEqual(['20 minutes', '10 minutes']);
  });

  it('keeps two durations in one sentence separate', () => {
    expect(seconds('Simmer 20 minutes, then rest 10 minutes')).toEqual([20 * 60, 10 * 60]);
  });

  it('does not merge two parts in the same unit', () => {
    // Only a strictly smaller unit continues a compound duration, so this is two timers,
    // not one 30-minute timer.
    expect(seconds('Cook 10 minutes 20 minutes')).toEqual([10 * 60, 20 * 60]);
  });

  it('returns durations in the order they appear', () => {
    const text = 'Rest 1 hour, bake 25 min, cool 5 minutes';
    expect(seconds(text)).toEqual([3600, 25 * 60, 5 * 60]);
    const found = findStepDurations(text);
    expect(found[0]!.start).toBeLessThan(found[1]!.start);
    expect(found[1]!.start).toBeLessThan(found[2]!.start);
  });

  it('ignores a fraction rather than reading its denominator as the amount', () => {
    // "1/2 hour" is 30 minutes, which this parser does not model. Offering no timer is the
    // safe reading; taking the "2" would offer a 2-hour one.
    expect(findStepDurations('Chill 1/2 hour')).toEqual([]);
  });

  it('ignores a zero-length duration', () => {
    expect(findStepDurations('Wait 0 minutes')).toEqual([]);
  });

  it('does not attach a later phrase to a duration a skipped phrase came between', () => {
    // The "0 hours" is dropped; the "30 minutes" after it is its own timer rather than
    // 30 minutes added to the bake.
    expect(seconds('Bake 20 minutes, wait 0 hours 30 minutes')).toEqual([20 * 60, 30 * 60]);
  });

  it('takes the longer bound of a range whose ends carry their own units', () => {
    const text = 'Bake 45 minutes to 1 hour, until the top is golden.';
    expect(seconds(text)).toEqual([3600]);
    expect(phrases(text)).toEqual(['45 minutes to 1 hour']);
    expect(seconds('Roast 1 hour to 90 minutes')).toEqual([90 * 60]);
    expect(seconds('Bake 20 minutes - 25 minutes')).toEqual([25 * 60]);
  });

  it('does not read a sentence break as a range', () => {
    expect(seconds('Bake 45 minutes. Rest 1 hour.')).toEqual([45 * 60, 3600]);
    expect(seconds('Simmer 20 minutes, then chill 2 hours')).toEqual([20 * 60, 2 * 3600]);
  });

  it('ignores a duration too long to be a kitchen timer', () => {
    expect(findStepDurations('Wait 100000000 minutes')).toEqual([]);
    // A day-long brine is real and stays.
    expect(seconds('Brine 24 hours')).toEqual([24 * 3600]);
    expect(findStepDurations('Age 30 days')).toEqual([]); // days are not a unit this reads
    expect(findStepDurations('Cure 48 hours')).toEqual([]);
  });

  it('returns nothing for text with no duration', () => {
    expect(findStepDurations('')).toEqual([]);
    expect(findStepDurations('Season with salt and serve.')).toEqual([]);
  });

  it('reports spans that slice back out of the original text', () => {
    const text = 'Sear 3 minutes per side, then roast 25-30 minutes.';
    for (const d of findStepDurations(text)) {
      expect(text.slice(d.start, d.end)).toMatch(/^\d/);
      expect(d.end).toBeGreaterThan(d.start);
      expect(d.end).toBeLessThanOrEqual(text.length);
    }
    expect(phrases(text)).toEqual(['3 minutes', '25-30 minutes']);
  });
});

describe('findStepDurations on hostile text', () => {
  // Imported steps come from untrusted pages, and cook mode scans every step on render.
  it('a long run of digits costs linear time', () => {
    const started = performance.now();
    findStepDurations(`${'1'.repeat(200_000)} x`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('still reads a duration that follows a long number', () => {
    expect(findStepDurations(`${'9'.repeat(50)} then bake 20 minutes`)).toHaveLength(1);
  });
});
