import { useEffect, useRef, useState } from 'react';
import type { ResponseIdleView } from '../../protocol/generated/views';
import { responseIdleSeconds } from '../../core/game/responseIdle';
import { useT } from '../i18n';
import './matchMessages';
import styles from './DecisionIdleNotice.module.css';

/** A small own-seat warning. It neither sends an answer nor changes engine clocks. */
export function DecisionIdleNotice({ timing, active }: { timing?: ResponseIdleView; active: boolean }) {
  const t = useT();
  const report = `${timing?.deadlineEpochMs}|${timing?.sampledAtEpochMs}|${timing?.remainingMillis}`;
  const anchor = useRef<{ report: string; at: number } | null>(null);
  const [clock, setClock] = useState<{ report: string; at: number; now: number } | null>(null);
  useEffect(() => {
    if (timing?.status !== 'running') { anchor.current = null; return; }
    if (anchor.current?.report !== report) anchor.current = { report, at: performance.now() };
    if (!active) return;
    const at = anchor.current.at;
    const update = () => setClock({ report, at, now: performance.now() });
    const immediate = setTimeout(update, 0);
    const interval = setInterval(update, 250);
    return () => { clearTimeout(immediate); clearInterval(interval); };
  }, [active, report, timing?.status]);
  const left = responseIdleSeconds(timing, clock?.report === report ? clock.at : 0, clock?.report === report ? clock.now : 0);
  if (!active || left === null) return null;
  const time = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  return <p className={styles.notice} data-urgent={left <= 60 ? '' : undefined} title={t('match.idle.hint')}>
    <span role="timer" aria-live="off">{t('match.idle.remaining', { time })}</span>
    <span className={styles.srOnly} role="status">{left <= 60 ? t('match.idle.expiring') : t('match.idle.hint')}</span>
  </p>;
}
