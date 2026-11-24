import { useContext } from 'react';
import { MatchHumanSeat } from './humanSeat';
import { useT } from '../i18n';
import { AgentModelLabel } from './AgentModelLabel';
import type { AgentModel } from './agentModel';
import { playerIdentity } from './playerIdentity';
import { usePlayerIdentity } from './usePlayerIdentity';
import styles from './PlayerLabel.module.css';

interface PlayerLabelProps {
  name: string;
  displayName?: string | null;
  isMcp?: boolean;
  humanMcpAllowed?: boolean;
  showModel?: boolean;
  modelInfo?: AgentModel;
}

export function PlayerLabel({ name, displayName, isMcp, humanMcpAllowed, showModel, modelInfo }: PlayerLabelProps) {
  const t = useT();
  const enabledName = useContext(MatchHumanSeat);
  const allowed = humanMcpAllowed ?? (enabledName === name.toLowerCase());
  const needsOwner = isMcp === undefined || (isMcp && !displayName);
  const found = usePlayerIdentity(name, needsOwner || (!!showModel && isMcp !== false && !modelInfo));
  const seat = (needsOwner && found) || playerIdentity(name, displayName, isMcp);
  return seat.isMcp || allowed ? <span className={styles.seat}>
    {seat.displayName && <span className={styles.name}>{seat.displayName}</span>}
    <span className={styles.badge}>{allowed ? t('home.humanMcpBadge') : 'MCP'}</span>
    {seat.isMcp && (modelInfo || showModel) && <AgentModelLabel {...(modelInfo ?? found)} />}
  </span> : <>{seat.displayName}</>;
}
