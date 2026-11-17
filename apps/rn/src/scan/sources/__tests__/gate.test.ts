/**
 * Card A4 — frame rate gate (the ~2.5 fps budget VisionCamera v5 no longer provides).
 */
import {createRateGate} from '../gate';

describe('createRateGate', () => {
  test('accepts the first call and then enforces the interval', () => {
    const gate = createRateGate(400);

    expect(gate.tryAccept(1000)).toBe(true);
    expect(gate.lastAcceptedAt()).toBe(1000);

    expect(gate.tryAccept(1200)).toBe(false);
    expect(gate.tryAccept(1399)).toBe(false);
    expect(gate.tryAccept(1400)).toBe(true); // exactly one interval later
    expect(gate.lastAcceptedAt()).toBe(1400);
  });

  test('a rejected call does not push the next acceptance further out', () => {
    const gate = createRateGate(400);
    expect(gate.tryAccept(0)).toBe(true);
    expect(gate.tryAccept(250)).toBe(false);
    expect(gate.tryAccept(399)).toBe(false);
    expect(gate.tryAccept(400)).toBe(true);
  });

  test('reset() forgets the last acceptance', () => {
    const gate = createRateGate(400);
    expect(gate.tryAccept(0)).toBe(true);
    expect(gate.tryAccept(10)).toBe(false);

    gate.reset();
    expect(gate.lastAcceptedAt()).toBeUndefined();
    expect(gate.tryAccept(20)).toBe(true);
  });

  test('defaults to the injected clock', () => {
    let now = 5000;
    const gate = createRateGate(400, {now: () => now});

    expect(gate.tryAccept()).toBe(true);
    now = 5300;
    expect(gate.tryAccept()).toBe(false);
    now = 5400;
    expect(gate.tryAccept()).toBe(true);
  });

  test('rejects invalid intervals', () => {
    expect(() => createRateGate(-1)).toThrow(/>= 0/);
    expect(() => createRateGate(Number.NaN)).toThrow(/finite/);
  });
});
