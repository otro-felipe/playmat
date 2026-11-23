import { Brain, MessageSquare, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { PlayerView } from '../../protocol/generated/views';
import { useT } from '../i18n';
import './matchMessages';
import { Dialog } from '../ui/Dialog';
import { CardMarkdown } from '../ui/CardMarkdown';
import { seatAlias, type SeatDisplayNames } from './seatDisplayNames';
import logStyles from './GameLog.module.css';
import styles from './SpectatorCommentary.module.css';
import type { SpectatorFeedEvent } from './spectatorFeed';

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
export function SpectatorChatBubble({ playerId, side }: { playerId?: string; side: 'upper' | 'lower' }) {
  const context = useContext(audience);
  const t = useT();
  const player = context?.players.find(seat => seat.playerId === playerId);
  const line = player && context?.feed.filter(event => event.kind === 'chat' && event.playerName === player.name).at(-1);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const expires = line ? line.at + Math.max(12_000, line.text.length * 65) : 0;
  const subscribe = useCallback((notify: () => void) => {
    const remaining = expires - Date.now();
    if (remaining <= 0) return () => {};
    const timer = setTimeout(notify, remaining);
    return () => clearTimeout(timer);
  }, [expires]);
  const beforeDeadline = useCallback(() => Date.now() < expires, [expires]);
  const visible = useSyncExternalStore(subscribe, beforeDeadline, () => false);
  if (!line || !visible && focusedKey !== line.key) return null;
  return <div className={styles.bubble} data-side={side} tabIndex={0} role="status" aria-label={t('spectate.tableChat')}
    onFocus={() => setFocusedKey(line.key)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocusedKey(null); }}>
    <MessageSquare size={16} aria-hidden="true" /><span className={styles.multiline}>{line.text}</span>
  </div>;
}

export function SpectatorCommentary() {
  const context = useContext(audience);
  const t = useT();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const [selected, setSelected] = useState<SpectatorFeedEvent | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
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
          const seatLabel = seat < 0 ? name : t('spectate.seatName', { name, seat: seat + 1 });
          return <li key={event.key} className={styles.entry} data-kind={event.kind}>
            {event.kind === 'line' ? <>
              <b className={styles.meta}>{seatLabel}</b>
              <button type="button" className={styles.lineEvent} aria-haspopup="dialog"
                onClick={e => { opener.current = e.currentTarget; setSelected(event); }}>
                <Brain size={17} aria-hidden="true" />{t('spectate.lineSent')}
              </button>
            </> : <>
              <div className={styles.meta}><MessageSquare size={14} aria-hidden="true" />{t('spectate.tableChat')} <b>{seatLabel}</b></div>
              <div className={styles.multiline}>{event.text}</div>
            </>}
          </li>;
        })}
      </ol>
    </aside>}
    <Dialog open={!!selected} onOpenChange={next => { if (!next) setSelected(null); }} returnFocusRef={opener} title={t('spectate.lineSent')}>
      {selected && <div className={styles.multiline}><CardMarkdown text={selected.text} /></div>}
    </Dialog>
  </>;
}
