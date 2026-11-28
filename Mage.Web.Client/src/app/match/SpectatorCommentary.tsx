import { Brain, MessageSquare, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { PlayerView } from '../../protocol/generated/views';
import { useI18n, useT } from '../i18n';
import { archetypeIdentity, archetypeStyle } from '../ui/archetypeIdentity';
import { SeatAccents } from './seatAccents';
import './matchMessages';
import { Dialog } from '../ui/Dialog';
import { LineExplanationMarkdown } from '../ui/LineExplanationMarkdown';
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

/** Pilot commentary is markdown; the timeline previews it as plain text. */
function preview(text: string) {
  return text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '').replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ').trim();
}

/**
 * The table's chat and pilot commentary as a timeline: the first seat on the left, the second mirrored on the right,
 * each entry stamped with its time (and turn, for a pilot's line).
 */
export function SpectatorCommentary() {
  const context = useContext(audience);
  const accents = useContext(SeatAccents);
  const t = useT();
  const locale = useI18n((s) => s.locale);
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
  const clock = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  function close() { setOpen(false); launcher.current?.focus(); }
  return <>
    <div className={logStyles.toggle}><button ref={launcher} type="button" className={logStyles.launcher} aria-expanded={open}
      aria-controls={panelId} onClick={() => { pinned.current = true; setOpen(!open); }}>
      <MessageSquare aria-hidden="true" />{t('match.chat.title')}
    </button></div>
    {open && <aside id={panelId} aria-label={t('match.chat.panel')} className={[logStyles.drawer, logStyles.chatDrawer, styles.timelineDrawer].join(' ')}
      onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) close(); }}>
      <header className={logStyles.head}><h2>{t('match.chat.title')}</h2>
        <button type="button" className={styles.close} onClick={close} aria-label={t('match.chat.close')}><X size={20} /></button></header>
      <ol ref={list} className={styles.timeline} data-empty={feed.length ? undefined : ''} aria-live="polite" aria-relevant="additions"
        onScroll={event => { const el = event.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 12; }}>
        {!feed.length && <li className={logStyles.empty}>{t('match.chat.empty')}</li>}
        {feed.map(event => {
          const seat = players.findIndex(player => event.kind === 'line' ? player.playerId === event.playerId : player.name === event.playerName);
          const engineName = players[seat]?.name ?? event.playerName;
          const name = seatAlias(engineName, names) ?? engineName;
          const seatLabel = seat < 0 ? name : t('spectate.seatName', { name, seat: seat + 1 });
          // A seat's alias may add its owner ("Alba · Felipe"); its accent is keyed by the participant's name.
          const accent = accents && Object.keys(accents).find((key) => key === name || key === engineName || name.startsWith(key + ' · '));
          const colors = accent ? accents[accent] : null;
          const tint = archetypeStyle(colors ? archetypeIdentity(null, colors).colors : null);
          const stamp = <span className={styles.stamp}>
            {event.kind === 'line' && event.turn != null && <b>{t('spectate.turnShort', { n: event.turn })}</b>}
            <time dateTime={new Date(event.at).toISOString()}>{clock.format(event.at)}</time>
          </span>;
          return <li key={event.key} className={styles.entry} data-kind={event.kind} data-side={seat === 1 ? 'right' : seat === 0 ? 'left' : 'center'}
            data-tinted={colors ? '' : undefined} style={tint}>
            <div className={styles.card}>
              <div className={styles.meta}>
                <i className={styles.seatDot} aria-hidden="true" />
                <b>{seatLabel}</b>
                {stamp}
              </div>
              {event.kind === 'line' ? (
                <button type="button" className={styles.lineEvent} aria-haspopup="dialog" aria-label={t('spectate.lineSent')}
                  aria-describedby={panelId + event.key} onClick={e => { opener.current = e.currentTarget; setSelected(event); }}>
                  <span className={styles.lineKind}><Brain size={15} aria-hidden="true" />{t('spectate.lineSent')}</span>
                  <span className={styles.lineText} id={panelId + event.key}>{preview(event.text)}</span>
                </button>
              ) : <div className={styles.multiline}>
                <span className={styles.chatKind}><MessageSquare size={13} aria-hidden="true" />{t('spectate.tableChat')}</span>
                {event.text}
              </div>}
            </div>
          </li>;
        })}
      </ol>
    </aside>}
    <Dialog open={!!selected} onOpenChange={next => { if (!next) setSelected(null); }} returnFocusRef={opener} title={t('spectate.lineSent')}>
      {selected && <LineExplanationMarkdown text={selected.text} />}
    </Dialog>
  </>;
}
