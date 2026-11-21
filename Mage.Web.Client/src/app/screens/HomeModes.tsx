import { useId } from 'react';
import { useT, type MessageKey } from '../i18n';
import { homeModes, type HomeMode } from './playModes';
import styles from './HomeScreen.module.css';

const labels: Record<HomeMode, MessageKey> = {
  ai: 'home.mode.ai', meta: 'home.mode.meta', practice: 'home.mode.practice', friend: 'home.mode.friend', mcp: 'home.mode.mcp',
};
export function HomeModes({ mode, onChange, disabled }: { mode: HomeMode; onChange(mode: HomeMode): void; disabled: boolean }) {
  const t = useT();
  const group = useId();
  return <div className={styles.modes} role="radiogroup" aria-label={t('home.opponent')}>
    {homeModes.map(id => <label key={id} className={mode === id ? styles.mode + ' ' + styles.modeOn : styles.mode}>
      <input type="radio" name={group} checked={mode === id} disabled={disabled} onChange={() => onChange(id)} />
      {t(labels[id])}
    </label>)}
  </div>;
}
