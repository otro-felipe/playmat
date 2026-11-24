import { Clock, Eye } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../i18n';
import { Countdown } from '../tournaments/Countdown';
import { AgentModelLabel } from '../ui/AgentModelLabel';
import type { AgentModel } from '../ui/agentModel';
import styles from './SpectatorBoard.module.css';

export type ScoreSeat = AgentModel & { name: string; wins: number };

export function SpectatorFrame({ status, actions, children, matchScore, deadlineAt }: {
  status?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  matchScore?: ScoreSeat[];
  deadlineAt?: number;
}) {
  const [left, right] = matchScore?.length === 2 ? matchScore : [];
  const t = useT();
  return <main className={styles.shell}>
    <header role="banner" aria-label={t('watch.broadcast')} className={styles.header}>
      <div className={styles.title}><Eye size={20} aria-hidden="true" /><h1>{t('watch.mode')}</h1>
        {status && <span role="status" className={styles.status}>{status}</span>}
      </div>
      {(left && right || deadlineAt) && <div className={styles.matchInfo}>
        {left && right && <div role="group" className={styles.score} aria-label={t('watch.matchScore')}>
          <span className={styles.scoreSeat}><span>{left.name}</span><AgentModelLabel {...left} /></span>
          <strong>{left.wins}–{right.wins}</strong>
          <span className={styles.scoreSeat}><span>{right.name}</span><AgentModelLabel {...right} /></span>
        </div>}
        {deadlineAt && <div className={styles.clock}>
          <Clock size={14} aria-hidden="true" />
          <span>{t('watch.tableClock')}</span>
          <Countdown at={deadlineAt} expired={t('watch.extraTurns')} />
        </div>}
      </div>}
      {actions && <div className={styles.actions}>{actions}</div>}
    </header>
    <div className={styles.board}>{children}</div>
  </main>;
}
