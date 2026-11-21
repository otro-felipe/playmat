import { Eye } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '../i18n';
import styles from './SpectatorBoard.module.css';

export function SpectatorFrame({ status, actions, children }: { status?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  const t = useT();
  return <main className={styles.shell}>
    <header role="banner" aria-label={t('watch.broadcast')} className={styles.header}>
      <div className={styles.title}><Eye size={20} aria-hidden="true" /><h1>{t('watch.mode')}</h1>
        {status && <span role="status" className={styles.status}>{status}</span>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </header>
    <div className={styles.board}>{children}</div>
  </main>;
}
