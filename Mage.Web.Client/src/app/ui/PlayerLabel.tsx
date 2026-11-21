import { useContext } from 'react';
import { MatchHumanSeat } from './humanSeat';
import { useT } from '../i18n';
import { playerIdentity } from './playerIdentity';
import { usePlayerIdentity } from './usePlayerIdentity';
import styles from './PlayerLabel.module.css';

export function PlayerLabel({ name, displayName, isMcp, humanMcpAllowed }: { name: string; displayName?: string | null; isMcp?: boolean; humanMcpAllowed?: boolean }) {
  const t = useT();
  const enabledName = useContext(MatchHumanSeat);
  const allowed = humanMcpAllowed ?? (enabledName === name.toLowerCase());
  const needsOwner = isMcp === undefined || (isMcp && !displayName);
  const found = usePlayerIdentity(name, needsOwner);
  const seat = (needsOwner && found) || playerIdentity(name, displayName, isMcp);
  return seat.isMcp || allowed ? <span className={styles.seat}>
    {seat.displayName && <span className={styles.name}>{seat.displayName}</span>}
    <span className={styles.badge}>{allowed ? t('home.humanMcpBadge') : 'MCP'}</span>
  </span> : <>{seat.displayName}</>;
}
