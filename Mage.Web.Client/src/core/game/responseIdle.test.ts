import { describe, expect, test } from 'vitest';
import { responseIdleSeconds } from './responseIdle';

describe('own response-idle countdown', () => {
  const sample = { status: 'running', deadlineEpochMs: 2_000_000, sampledAtEpochMs: 1_100_000, remainingMillis: 900_000 };
  test('counts a server sample with monotonic elapsed time, independent of client epoch/skew', () => {
    expect(responseIdleSeconds(sample, 12, 12)).toBe(900);
    expect(responseIdleSeconds(sample, 12, 5_012)).toBe(895);
    expect(responseIdleSeconds({ ...sample, sampledAtEpochMs: 100, deadlineEpochMs: 900_100 }, 12, 5_012)).toBe(895);
    expect(responseIdleSeconds(sample, 12, 900_012)).toBe(0);
    expect(responseIdleSeconds({ ...sample, remainingMillis: 0 }, 12, 20)).toBe(0);
  });
  test('unknown, disabled, inactive and malformed samples never imply unlimited time or a made-up timer', () => {
    expect(responseIdleSeconds(undefined, 0, 1)).toBeNull();
    for (const status of ['unknown', 'inactive', 'disabled']) expect(responseIdleSeconds({ ...sample, status }, 0, 1)).toBeNull();
    expect(responseIdleSeconds({ ...sample, remainingMillis: -1 }, 0, 1)).toBeNull();
    expect(responseIdleSeconds({ ...sample, deadlineEpochMs: undefined }, 0, 1)).toBeNull();
  });
});
