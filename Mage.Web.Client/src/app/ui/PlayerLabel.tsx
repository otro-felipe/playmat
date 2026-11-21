import { playerIdentity } from './playerIdentity';
import { usePlayerIdentity } from './usePlayerIdentity';
import styles from './PlayerLabel.module.css';

export function PlayerLabel({ name, displayName, isMcp }: { name: string; displayName?: string | null; isMcp?: boolean }) {
  const needsOwner = isMcp === undefined || (isMcp && !displayName);
  const found = usePlayerIdentity(name, needsOwner);
  const seat = (needsOwner && found) || playerIdentity(name, displayName, isMcp);
  return seat.isMcp ? <span className={styles.seat}>
    {seat.displayName && <span className={styles.name}>{seat.displayName}</span>}
    <span className={styles.badge}>MCP</span>
  </span> : <>{seat.displayName}</>;
}
