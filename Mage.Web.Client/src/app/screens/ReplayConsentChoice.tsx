import { useId } from 'react';
import { useT } from '../i18n';
import styles from './ReplayConsentChoice.module.css';

export function ReplayConsentChoice({ checked, onChange, disabled }: {
  checked: boolean;
  onChange(value: boolean): void;
  disabled?: boolean;
}) {
  const t = useT();
  const descriptionId = useId();
  return (
    <div className={styles.choice}>
      <button className={styles.control} type="button" role="switch" aria-checked={checked}
        aria-describedby={descriptionId} onClick={() => onChange(!checked)} disabled={disabled}>
        <span className={styles.track} aria-hidden="true" />
        <span>{t('replayConsent.label')}</span>
      </button>
      <p id={descriptionId}>{t('replayConsent.notice')}</p>
    </div>
  );
}
