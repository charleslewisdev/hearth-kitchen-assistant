import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { TimerTray, formatClock, useCookTimers, type CookTimer } from './TimerTray';

/**
 * The tray as cook mode wires it: state above, rendering below. The two "start" buttons stand
 * in for the tappable phrases inside a step.
 */
function Harness({ restored }: { restored?: CookTimer[] }) {
  const { timers, start, cancel } = useCookTimers(restored);
  return (
    <div>
      <button type="button" onClick={() => start('Step 1 · 20 minutes', 20 * 60)}>
        start broth
      </button>
      <button type="button" onClick={() => start('Step 2 · 30 seconds', 30)}>
        start whisk
      </button>
      <button type="button" onClick={() => start('Step 3 · 1 hour 30 min', 90 * 60)}>
        start roast
      </button>
      <TimerTray timers={timers} onCancel={cancel} />
    </div>
  );
}

/** A Web Audio stand-in that records what was played. */
function installAudioContext() {
  const oscillators: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];
  const context = {
    currentTime: 0,
    state: 'running',
    resume: vi.fn(async () => {}),
    destination: {},
    createOscillator: vi.fn(() => {
      const oscillator = {
        type: '',
        frequency: { value: 0 },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      oscillators.push(oscillator);
      return oscillator;
    }),
    createGain: vi.fn(() => ({
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    })),
  };
  const ctor = vi.fn(() => context);
  Object.defineProperty(window, 'AudioContext', {
    value: ctor,
    configurable: true,
    writable: true,
  });
  return { ctor, context, oscillators };
}

/** Move the clock, and let the tray's interval catch up with it. */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-10T10:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as { AudioContext?: unknown }).AudioContext;
  delete (navigator as { vibrate?: unknown }).vibrate;
  vi.restoreAllMocks();
});

function tray() {
  return screen.getByRole('list', { name: 'Running timers' });
}

describe('the cook timer tray', () => {
  it('is not there until a timer is started', () => {
    render(<Harness />);
    expect(screen.queryByRole('list', { name: 'Running timers' })).not.toBeInTheDocument();
  });

  it('shows a started timer counting down', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('start broth'));

    expect(within(tray()).getByText('Step 1 · 20 minutes')).toBeInTheDocument();
    expect(within(tray()).getByText('20:00')).toBeInTheDocument();

    advance(61_000);
    expect(within(tray()).getByText('18:59')).toBeInTheDocument();
  });

  it('runs two timers independently', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('start broth'));
    advance(5_000);
    fireEvent.click(screen.getByText('start whisk'));
    advance(10_000);

    const rows = within(tray()).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('19:45')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('0:20')).toBeInTheDocument();
  });

  it('cancels one timer and leaves the other running', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('start broth'));
    fireEvent.click(screen.getByText('start whisk'));

    fireEvent.click(screen.getByRole('button', { name: /Stop Step 1 · 20 minutes/ }));

    const rows = within(tray()).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText('Step 2 · 30 seconds')).toBeInTheDocument();
  });

  it('announces a timer that has finished, and keeps it in the tray until it is stopped', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('start whisk'));

    advance(30_000);
    expect(within(tray()).getByText('Done')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Step 2 · 30 seconds');

    fireEvent.click(screen.getByRole('button', { name: /Stop Step 2 · 30 seconds/ }));
    expect(screen.queryByRole('list', { name: 'Running timers' })).not.toBeInTheDocument();
  });

  it('still says Done long after firing rather than counting on', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('start whisk'));
    advance(120_000);
    expect(within(tray()).getByText('Done')).toBeInTheDocument();
  });

  it('opens the audio context on the tap that starts a timer, not when it fires', () => {
    const { ctor } = installAudioContext();
    render(<Harness />);

    fireEvent.click(screen.getByText('start whisk'));
    // Audio may only start from a user gesture, and this is the gesture. Minutes later, when
    // the timer fires, there is no gesture left to ask for.
    expect(ctor).toHaveBeenCalledTimes(1);
  });

  it('beeps when a timer fires, and again while it is left ringing', () => {
    const { oscillators } = installAudioContext();
    render(<Harness />);
    fireEvent.click(screen.getByText('start whisk'));
    expect(oscillators).toHaveLength(0);

    advance(30_000);
    const firstBurst = oscillators.length;
    expect(firstBurst).toBeGreaterThan(0);
    for (const oscillator of oscillators) expect(oscillator.start).toHaveBeenCalled();

    // Still ringing five seconds later, because one burst is easy to miss over a hot pan.
    advance(5_000);
    expect(oscillators.length).toBeGreaterThan(firstBurst);
  });

  it('stops beeping once the timer is stopped', () => {
    const { oscillators } = installAudioContext();
    render(<Harness />);
    fireEvent.click(screen.getByText('start whisk'));
    advance(30_000);
    const atFiring = oscillators.length;

    fireEvent.click(screen.getByRole('button', { name: /Stop Step 2 · 30 seconds/ }));
    advance(30_000);
    expect(oscillators).toHaveLength(atFiring);
  });

  it('gives up beeping rather than ringing forever', () => {
    const { oscillators } = installAudioContext();
    render(<Harness />);
    fireEvent.click(screen.getByText('start whisk'));
    advance(30_000);

    advance(5 * 60_000);
    const afterFiveMinutes = oscillators.length;
    advance(5 * 60_000);
    expect(oscillators).toHaveLength(afterFiveMinutes);
  });

  it('vibrates when a timer fires, where the device offers it', () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
    render(<Harness />);
    fireEvent.click(screen.getByText('start whisk'));
    advance(30_000);
    expect(vibrate).toHaveBeenCalled();
  });

  it('runs with no Web Audio and no vibration at all', () => {
    expect((window as { AudioContext?: unknown }).AudioContext).toBeUndefined();
    expect((navigator as { vibrate?: unknown }).vibrate).toBeUndefined();

    render(<Harness />);
    fireEvent.click(screen.getByText('start whisk'));
    expect(() => advance(35_000)).not.toThrow();
    expect(within(tray()).getByText('Done')).toBeInTheDocument();
  });

  it('shows hours on a timer longer than one', () => {
    render(<Harness />);
    fireEvent.click(screen.getByText('start roast'));
    expect(within(tray()).getByText('1:30:00')).toBeInTheDocument();

    advance(31 * 60_000);
    expect(within(tray()).getByText('59:00')).toBeInTheDocument();
  });
});

describe('timers restored after a reload', () => {
  const now = () => Date.now();

  it('resumes a running timer with the time it has left, not the time it was set for', () => {
    render(
      <Harness
        restored={[
          {
            id: 'timer-1',
            label: 'Step 1 · 20 minutes',
            totalSeconds: 1200,
            endsAt: now() + 12 * 60_000,
          },
        ]}
      />,
    );
    expect(within(tray()).getByText('12:00')).toBeInTheDocument();
    advance(60_000);
    expect(within(tray()).getByText('11:00')).toBeInTheDocument();
  });

  it('shows Done for a timer that finished while the page was gone', () => {
    render(
      <Harness
        restored={[
          {
            id: 'timer-1',
            label: 'Step 2 · 30 seconds',
            totalSeconds: 30,
            endsAt: now() - 10 * 60_000,
          },
        ]}
      />,
    );
    expect(within(tray()).getByText('Done')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Step 2 · 30 seconds timer finished');
  });

  it('still rings for one that finished moments ago, as it would have with the page open', () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
    render(
      <Harness
        restored={[
          { id: 'timer-1', label: 'Step 2 · 30 seconds', totalSeconds: 30, endsAt: now() - 10_000 },
        ]}
      />,
    );
    expect(vibrate).toHaveBeenCalledTimes(1);
    advance(5_000);
    expect(vibrate).toHaveBeenCalledTimes(2);
  });

  it('does not ring for one that finished long ago', () => {
    const vibrate = vi.fn(() => true);
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
    render(
      <Harness
        restored={[
          {
            id: 'timer-1',
            label: 'Step 2 · 30 seconds',
            totalSeconds: 30,
            endsAt: now() - 10 * 60_000,
          },
        ]}
      />,
    );
    advance(10_000);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('gives a new timer an id of its own beside the restored ones', () => {
    render(
      <Harness
        restored={[
          {
            id: 'timer-1',
            label: 'Step 1 · 20 minutes',
            totalSeconds: 1200,
            endsAt: now() + 60_000,
          },
          {
            id: 'timer-7',
            label: 'Step 3 · 1 hour 30 min',
            totalSeconds: 5400,
            endsAt: now() + 120_000,
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByText('start whisk'));
    expect(within(tray()).getAllByRole('listitem')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: /Stop Step 2 · 30 seconds/ }));
    expect(within(tray()).getAllByRole('listitem')).toHaveLength(2);
  });

  it('opens the audio context on the first tap after a reload, so the alarm can sound', () => {
    // The tap that started the timer belonged to the page that is gone. Without a new one the
    // restored timer could only flash Done.
    const { ctor, oscillators } = installAudioContext();
    render(
      <Harness
        restored={[
          { id: 'timer-1', label: 'Step 2 · 30 seconds', totalSeconds: 30, endsAt: now() + 20_000 },
        ]}
      />,
    );
    expect(ctor).not.toHaveBeenCalled();

    fireEvent.pointerDown(document.body);
    expect(ctor).toHaveBeenCalledTimes(1);

    advance(20_000);
    expect(oscillators.length).toBeGreaterThan(0);
  });
});

describe('formatClock', () => {
  it('counts in m:ss below an hour and h:mm:ss from one', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(9)).toBe('0:09');
    expect(formatClock(59)).toBe('0:59');
    expect(formatClock(3599)).toBe('59:59');
    expect(formatClock(3600)).toBe('1:00:00');
    expect(formatClock(3661)).toBe('1:01:01');
  });

  it('rounds a part-second UP, so a timer never shows a second it has not finished', () => {
    expect(formatClock(19.2)).toBe('0:20');
    expect(formatClock(0.4)).toBe('0:01');
  });

  it('clamps a negative to zero rather than printing a minus sign', () => {
    expect(formatClock(-5)).toBe('0:00');
  });
});
