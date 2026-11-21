import styles from './Switch.module.css';

export function Switch({ checked, label, onCheckedChange, controls, disabled }: {
  checked: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
  controls?: string;
  disabled?: boolean;
}) {
  return (
    <button type="button" className={styles.switch} role="switch" aria-checked={checked} aria-controls={controls} disabled={disabled}
      onClick={() => onCheckedChange(!checked)}>
      <span className={styles.track} aria-hidden="true"><span /></span>
      {label}
    </button>
  );
}
