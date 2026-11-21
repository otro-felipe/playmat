import { Brain, MessageSquare, X } from 'lucide-react';
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PlayerView } from '../../protocol/generated/views';
import { useT } from '../i18n';
import './matchMessages';
import { CardMarkdown } from '../ui/CardMarkdown';
import { seatAlias, type SeatDisplayNames } from './seatDisplayNames';
import logStyles from './GameLog.module.css';
import styles from './SpectatorCommentary.module.css';

export interface SpectatorLine {
  lineId: string;
  playerId: string;
  playerName: string;
  reasoning: string;
  at: number;
  turn?: number;
}
export interface SpectatorChatMessage {
  messageId: string;
  playerName: string;
  message: string;
  at: number;
}
export type SpectatorFeedEvent = { gameId: string; key: string; at: number; playerName: string; text: string } & (
  { kind: 'line'; playerId: string } | { kind: 'chat' }
);

/** Reconnect snapshots can repeat events. Command IDs are unique within an acting seat. */
export function spectatorFeed(gameId: string, lines: readonly SpectatorLine[] = [], chat: readonly SpectatorChatMessage[] = []) {
  const rows = new Map<string, SpectatorFeedEvent>();
  for (const line of lines) {
    if (!line.lineId || !line.playerId || !line.reasoning?.trim() || !Number.isFinite(line.at)) continue;
    const key = JSON.stringify([gameId, 'line', line.playerId, line.lineId]);
    rows.set(key, { key, gameId, kind: 'line', playerId: line.playerId, playerName: line.playerName, text: line.reasoning, at: line.at });
  }
  for (const item of chat) {
    if (!item.messageId || !item.message?.trim() || !Number.isFinite(item.at)) continue;
    const key = JSON.stringify([gameId, 'chat', item.messageId]);
    rows.set(key, { key, gameId, kind: 'chat', playerName: item.playerName, text: item.message, at: item.at });
  }
  return [...rows.values()].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

const audience = createContext<{
  feed: readonly SpectatorFeedEvent[];
  players: readonly PlayerView[];
  names?: SeatDisplayNames;
} | null>(null);

export function SpectatorCommentaryProvider({ gameId, events, players, names, children }: {
  gameId: string; events: readonly SpectatorFeedEvent[]; players: readonly PlayerView[]; names?: SeatDisplayNames; children: ReactNode;
}) {
  const value = useMemo(() => ({ feed: events.filter(event => event.gameId === gameId), players, names }), [gameId, events, players, names]);
  return <audience.Provider value={value}>{children}</audience.Provider>;
}

/** Keep short-lived speech attached to the public board's player ID through perspective changes. */
export function SpectatorLineBubble({ playerId, side }: { playerId?: string; side: 'upper' | 'lower' }) {
  const context = useContext(audience);
  const t = useT();
  const line = context?.feed.filter(event => event.kind === 'line' && event.playerId === playerId).at(-1);
  const [expired, setExpired] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const expires = (line?.at ?? 0) + 12_000;
  useEffect(() => {
    if (!line) return;
    const timer = setTimeout(() => setExpired(line.key), Math.max(0, expires - Date.now()));
    return () => clearTimeout(timer);
  }, [line?.key, expires]);
  if (!line || !focused && (expired === line.key || Date.now() >= expires)) return null;
  return <div className={styles.bubble} data-side={side} role="status" aria-label={t('spectate.audienceNote')}
    onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <Brain size={16} aria-hidden="true" /><span className={styles.excerpt}><CardMarkdown text={line.text} /></span>
  </div>;
}

export function SpectatorCommentary() {
  const context = useContext(audience);
  const t = useT();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const launcher = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  const last = context?.feed.at(-1)?.key;
  useEffect(() => {
    if (open && pinned.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [open, last]);
  if (!context) return null;
  const { players, feed, names } = context;
  function close() { setOpen(false); launcher.current?.focus(); }
  return <>
    <div className={logStyles.toggle}><button ref={launcher} type="button" className={logStyles.launcher} aria-expanded={open}
      aria-controls={panelId} onClick={() => { pinned.current = true; setOpen(!open); }}>
      <MessageSquare aria-hidden="true" />{t('match.chat.title')}
    </button></div>
    {open && <aside id={panelId} aria-label={t('match.chat.panel')} className={[logStyles.drawer, logStyles.chatDrawer].join(' ')}
      onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) close(); }}>
      <header className={logStyles.head}><h2>{t('match.chat.title')}</h2>
        <button type="button" className={styles.close} onClick={close} aria-label={t('match.chat.close')}><X size={20} /></button></header>
      <ol ref={list} className={logStyles.lines} aria-live="polite" aria-relevant="additions"
        onScroll={event => { const el = event.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 12; }}>
        {!feed.length && <li className={logStyles.empty}>{t('match.chat.empty')}</li>}
        {feed.map(event => {
          const seat = players.findIndex(player => event.kind === 'line' ? player.playerId === event.playerId : player.name === event.playerName);
          const engineName = players[seat]?.name ?? event.playerName;
          const name = seatAlias(engineName, names) ?? engineName;
          const Icon = event.kind === 'line' ? Brain : MessageSquare;
          return <li key={event.key} className={styles.entry} data-kind={event.kind}>
            <div className={styles.meta}><Icon size={14} aria-hidden="true" /><span>{t(event.kind === 'line' ? 'spectate.audienceNote' : 'spectate.tableChat')}</span>
              <b>{seat < 0 ? name : t('spectate.seatName', { name, seat: seat + 1 })}</b></div>
            <CardMarkdown text={event.text} />
          </li>;
        })}
      </ol>
    </aside>}
  </>;
}
