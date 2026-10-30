import { useCallback, useEffect, useRef, useState } from 'react';
import styles from './TimerTray.module.css';

/** One running kitchen timer. */
export interface CookTimer {
  id: string;
  /** What it is for, e.g. `Step 2 · 20 minutes`. Shown in the tray and read to the cook. */
  label: string;
  /** How long it was set for, which is what the ring is drawn against. */
  totalSeconds: number;
  /** Wall-clock time it comes due, in epoch milliseconds. */
  endsAt: number;
}

/** How often the tray recomputes what it shows. */
const TICK_MS = 500;

/** How long between repeat alarms while a fired timer is left unattended. */
const REPEAT_ALARM_MS = 5_000;

/**
 * How long a fired timer keeps sounding before it goes quiet and stays only visual.
 *
 * A cook who has not come back within a minute is not in the room, and nothing this screen can
 * do without a notification permission will reach them there.
 */
const ALARM_TIMEOUT_MS = 60_000;

type AudioContextCtor = new () => AudioContext;

/** Web Audio, where the browser has it. Absent in some embedded webviews. */
function audioContextCtor(): AudioContextCtor | undefined {
  const scope = window as typeof window & {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return scope.AudioContext ?? scope.webkitAudioContext;
}

/**
 * Three short square-wave beeps.
 *
 * Square rather than sine because its harmonics carry over an extractor fan; the three-pulse
 * pattern because one tone reads as an incidental noise and a pattern reads as a device.
 */
function beep(context: AudioContext): void {
  const start = context.currentTime;
  for (let pulse = 0; pulse < 3; pulse += 1) {
    const at = start + pulse * 0.45;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'square';
    oscillator.frequency.value = 880;
    // Ramped rather than switched, because an instant square wave clicks.
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.3, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.3);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.32);
  }
}

/** Seconds as `m:ss`, or `h:mm:ss` once there is an hour to show. */
export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.ceil(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/**
 * The running timers, and the two things a cook does with them.
 *
 * This state lives HERE - above the step list - on purpose. A timer owned by the step component
 * that started it dies when that step unmounts, and is off screen long before that: the cook
 * scrolls on to step 5 while the pan from step 2 is still going. The tray is the only place a
 * timer stays reachable from, which is what D26's sticky tray is for. `CookMode.test.tsx`
 * unmounts a step underneath a running timer to hold that.
 *
 * `restored` seeds the tray with timers saved before a reload (see `cookSession.ts`). It is read
 * once, on mount. A restored timer is treated exactly like one started on this page: one that
 * came due while the page was gone shows Done, and rings only if it came due within the last
 * `ALARM_TIMEOUT_MS`, the same rule that silences a timer left ringing with the page open. So a
 * cook who comes back ten minutes late sees Done rather than getting a minute of beeping.
 */
export function useCookTimers(restored: readonly CookTimer[] = []): {
  timers: CookTimer[];
  start: (label: string, seconds: number) => void;
  cancel: (id: string) => void;
} {
  // Restored timers are renumbered, so ids stay the simple counter below and cannot collide
  // with one started after the reload.
  const [timers, setTimers] = useState<CookTimer[]>(() =>
    restored.map((timer, index) => ({ ...timer, id: `timer-${index + 1}` })),
  );
  const [, forceTick] = useState(0);
  const audioRef = useRef<AudioContext | null>(null);
  /** When each fired timer was last signalled, so a repeat is spaced rather than continuous. */
  const lastAlarmRef = useRef<Map<string, number>>(new Map());
  /** Ids only have to be unique within one visit to this screen, so a counter is enough. */
  const nextIdRef = useRef(restored.length);

  // Close the audio context when cook mode is left, so an open one is not carried around the
  // rest of the app.
  useEffect(() => {
    return () => {
      const context = audioRef.current;
      audioRef.current = null;
      if (context) void context.close?.().catch(() => {});
    };
  }, []);

  /*
    Open the audio context, from inside a user gesture.

    Browsers only let audio start from a user gesture, and the gesture that will be available
    when the timer fires - twenty minutes from now, with the cook's hands in a bowl - is none.
    Creating and resuming it on a tap spends that tap on the permission the alarm will need.
    Nothing is played now.
  */
  const openAudio = useCallback(() => {
    const Ctor = audioContextCtor();
    if (Ctor && !audioRef.current) {
      try {
        audioRef.current = new Ctor();
      } catch {
        audioRef.current = null;
      }
    }
    void audioRef.current?.resume?.().catch(() => {});
  }, []);

  // A timer restored after a reload was started by a tap on the page that is gone, so this page
  // has no audio context for its alarm. The cook's next tap or key press anywhere - ticking a
  // step, most likely - opens one. Until then a restored alarm can only vibrate and show Done.
  // On a page where the cook started the timer, the context already exists and this is inert.
  useEffect(() => {
    if (timers.length === 0 || audioRef.current !== null) return;
    function unlock(): void {
      openAudio();
      if (audioRef.current !== null) stopListening();
    }
    function stopListening(): void {
      document.removeEventListener('pointerdown', unlock, true);
      document.removeEventListener('keydown', unlock, true);
    }
    document.addEventListener('pointerdown', unlock, true);
    document.addEventListener('keydown', unlock, true);
    return stopListening;
  }, [timers.length, openAudio]);

  const start = useCallback(
    (label: string, seconds: number) => {
      // Open the audio context on THIS tap, the one that started the timer; see `openAudio`.
      openAudio();

      // Built out here rather than inside the updater below, which React is free to call more
      // than once: an id and a deadline that change per call would not survive that.
      // A counter rather than crypto.randomUUID, which is unavailable on insecure origins -
      // where this app can legitimately run.
      nextIdRef.current += 1;
      const timer: CookTimer = {
        id: `timer-${nextIdRef.current}`,
        label,
        totalSeconds: seconds,
        endsAt: Date.now() + seconds * 1000,
      };
      setTimers((previous) => [...previous, timer]);
    },
    [openAudio],
  );

  const cancel = useCallback((id: string) => {
    lastAlarmRef.current.delete(id);
    setTimers((previous) => previous.filter((timer) => timer.id !== id));
  }, []);

  // A single interval drives every timer. The countdown is derived from the wall clock, so a
  // throttled or skipped tick shows a stale number for a moment and never a wrong one.
  useEffect(() => {
    if (timers.length === 0) return;
    const handle = setInterval(() => forceTick((value) => value + 1), TICK_MS);
    return () => clearInterval(handle);
  }, [timers.length]);

  // Sound the timers that are due. Runs on every tick because a fired timer left unattended
  // repeats, which is the difference between a timer that works with hands busy and one that
  // only works if the cook happened to be looking.
  useEffect(() => {
    const now = Date.now();
    for (const timer of timers) {
      if (timer.endsAt > now) continue;
      if (now - timer.endsAt > ALARM_TIMEOUT_MS) continue;
      const lastAlarm = lastAlarmRef.current.get(timer.id);
      if (lastAlarm !== undefined && now - lastAlarm < REPEAT_ALARM_MS) continue;
      lastAlarmRef.current.set(timer.id, now);

      const context = audioRef.current;
      if (context) {
        try {
          // A phone suspends the context when the tab goes to the background, which is exactly
          // when a long timer comes due. Resuming is a no-op on a running context and is what
          // gives the NEXT repeat, five seconds later, something audible to play through.
          void context.resume?.().catch(() => {});
          // Guards a CLOSED context, where createOscillator throws.
          beep(context);
        } catch {
          // Nothing audible this time. The row still turns amber and still says Done.
        }
      }
      try {
        // Android only: iOS Safari has no Vibration API, which is why this is a bonus signal
        // and not the one being relied on. Wrapped so that one device rejecting the pattern
        // cannot stop the loop from sounding the other timers that are due.
        navigator.vibrate?.([300, 150, 300, 150, 500]);
      } catch {
        // Declined by the device.
      }
    }
  });

  return { timers, start, cancel };
}

/** Circumference of the ring below, at r=19 in its 44-unit viewBox. */
const RING_LENGTH = 2 * Math.PI * 19;

/**
 * The sticky stacking tray from D26: dark, fixed to the bottom, and the only part of cook mode
 * that does not scroll. A cook four steps further down the recipe can still see and stop a
 * timer they started at the top, which is the whole reason it is not drawn inside the step.
 */
export function TimerTray({
  timers,
  onCancel,
}: {
  timers: CookTimer[];
  onCancel: (id: string) => void;
}) {
  if (timers.length === 0) return null;
  const now = Date.now();
  const finished = timers.filter((timer) => timer.endsAt <= now);

  return (
    <div className={styles.tray}>
      {/*
        Mounted for as long as the tray is, with its TEXT changing when a timer comes due.
        Screen readers announce a live region reliably that way; a node carrying role="alert"
        that is inserted at the moment it has something to say is the less dependable pattern.
      */}
      <div role="alert" className={styles.srOnly}>
        {finished.map((timer) => `${timer.label} timer finished`).join('. ')}
      </div>
      <ul className={styles.list} aria-label="Running timers">
        {timers.map((timer) => {
          const remaining = Math.max(0, (timer.endsAt - now) / 1000);
          const fired = remaining <= 0;
          const fraction = timer.totalSeconds > 0 ? remaining / timer.totalSeconds : 0;
          return (
            <li key={timer.id} className={fired ? styles.rowFired : styles.row}>
              <svg className={styles.ring} viewBox="0 0 44 44" aria-hidden="true">
                <circle className={styles.ringTrack} cx="22" cy="22" r="19" />
                <circle
                  className={styles.ringProgress}
                  cx="22"
                  cy="22"
                  r="19"
                  style={{
                    strokeDasharray: RING_LENGTH,
                    strokeDashoffset: RING_LENGTH * (1 - fraction),
                  }}
                />
              </svg>
              <div className={styles.readout}>
                <p className={styles.time}>{fired ? 'Done' : formatClock(remaining)}</p>
                <p className={styles.label}>{timer.label}</p>
              </div>
              <button
                type="button"
                className={styles.stop}
                onClick={() => onCancel(timer.id)}
                aria-label={`Stop ${timer.label}`}
              >
                Stop
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
