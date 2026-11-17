import type { ResponseIdleView } from '../../protocol/generated/views';

/** A server sample counted down with a monotonic client clock; never use the client's wall clock. */
export function responseIdleSeconds(sample: ResponseIdleView | undefined, receivedAt: number, now: number): number | null {
  if (sample?.status !== 'running' || !Number.isFinite(sample.remainingMillis) || sample.remainingMillis! < 0
    || !Number.isFinite(sample.deadlineEpochMs) || !Number.isFinite(sample.sampledAtEpochMs)) return null;
  return Math.max(0, Math.ceil((sample.remainingMillis! - Math.max(0, now - receivedAt)) / 1000));
}
