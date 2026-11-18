import {
  AlertTriangle, ArrowDownToLine, HelpCircle, Ban, BellRing, BookOpen, Dot, Flag, Flame, Heart, HeartCrack, MessageCircle,
  MessageSquare, Mountain, Pin, PinOff, Shield, Shuffle, Skull, Sparkles, Swords, Trophy, Archive, Zap, X, type LucideIcon,
} from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { DelayedRelay } from '../../core/game/broadcastDelay';
import { explainLog } from '../../core/game/logRules';
import type { GameNotice } from '../../core/game/gameSession';
import {
  buildLogRows, cardInk, collectCards, EMOTES, findLogCard, isEmote, noticeEntry, parseChatMessage, presenceChange,
  type LogEntry, type LogIcon, type LogSegment,
} from '../../core/game/gameLog';
import type { CardView, ChatMessage, GameView } from '../../protocol/generated/views';
import { api, events } from '../connection';
import { useT } from '../i18n';
import { readJson, writeJson } from '../stores/persist';
import { useSession } from '../stores/session';
import { useSocial } from '../stores/social';
import { IconButton } from '../ui/Button';
import { PromptText } from '../ui/PromptText';
import { useEmotes } from './emotes';
import { matchKeysBlocked } from './keyboard';
import './matchMessages';
import { useMatchUi } from './matchUi';
import { usePresence } from './presence';
import { seatDisplayName, type SeatDisplayNames } from './seatDisplayNames';
import styles from './GameLog.module.css';

const MAX_LINES = 300;
/** a pinned log stays open while the player plays; kept in this browser */
const PINNED_KEY = 'playmat.logPinned';

const ICONS: Record<LogIcon, LucideIcon> = {
  turn: Dot,
  cast: Sparkles,
  land: Mountain,
  ability: Zap,
  trigger: BellRing,
  attack: Swords,
  block: Shield,
  damage: Flame,
  lifeGain: Heart,
  lifeLoss: HeartCrack,
  draw: BookOpen,
  discard: ArrowDownToLine,
  counter: Ban,
  destroy: Skull,
  exile: Archive,
  mulligan: Shuffle,
  win: Trophy,
  lose: Flag,
  chat: MessageCircle,
  error: AlertTriangle,
  info: Dot,
};

/** Game chat and the game's running log, joined once per game (not for replays, which bring their own log). */
function useGameChat(gameId: string, view: GameView | null, live: boolean, delayMs: number) {
  // the latest view, read when a line arrives: it says whose turn the line belongs to
  const latest = useRef(view);
  useEffect(() => {
    latest.current = view;
  }, [view]);
  const loginCount = useSession((state) => state.loginCount);
  const userName = useSession((state) => state.userName);
  const [membership, setMembership] = useState<{ id: string; loginCount: number; userName: string; gameId: string } | null>(null);
  const chatId = membership?.loginCount === loginCount && membership.userName === userName && membership.gameId === gameId ? membership.id : null;
  const channel = useRef<string | null>(null);
  const seq = useRef(0);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [unread, setUnread] = useState(0);
  // watching with a broadcast delay: the log keeps pace with the delayed board, or it would give the game away
  const [relay] = useState(() => new DelayedRelay<() => void>((show) => show()));
  useEffect(() => relay.setDelay(delayMs), [relay, delayMs]);
  useEffect(() => () => relay.dispose(), [relay]);

  useEffect(() => {
    if (!live) return;
    return events.on('CHATMESSAGE', (message: ChatMessage, event) => {
      if (!channel.current || event.objectId !== channel.current) return;
      const parsed = parseChatMessage(message, `c${seq.current++}`);
      if (!parsed) return;
      const me = useSession.getState().userName;
      const fromOther = parsed.tone !== 'chat' || parsed.who !== me;
      const show = () => {
        const current = latest.current;
        const entry = parsed.turn !== null && parsed.turn === current?.turn && current.activePlayerName
          ? { ...parsed, turnOwner: current.activePlayerName }
          : parsed;
        setEntries((current) => [...current, entry].slice(-MAX_LINES));
        const presence = message.messageType === 'STATUS' ? presenceChange(entry.text) : null;
        if (presence) usePresence.getState().set(presence.name, presence.online);
        if (entry.tone !== 'chat') return;
        const muted = !!useEmotes.getState().muted[gameId];
        if (fromOther && muted) return;
        if (entry.who && isEmote(entry.text)) useEmotes.getState().show(entry.who, entry.text);
        if (fromOther) setUnread((count) => count + 1);
      };
      // one's own words show at once
      if (fromOther) relay.push(show);
      else show();
    });
  }, [live, gameId, relay]);

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    let joined: string | null = null;
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const join = async () => {
      try {
        const id = await api.chatFindByGame(gameId);
        if (cancelled) return;
        if (!id) throw new Error('Game chat not ready');
        // The join can itself deliver lines before the RPC promise resolves.
        channel.current = id;
        if (!await api.chatJoin(id, userName)) throw new Error('Game chat join failed');
        if (cancelled) {
          // A newer effect may already have joined the same chat. Do not undo its membership.
          if (channel.current !== id) await api.chatLeave(id);
          return;
        }
        joined = id;
        setMembership({ id, loginCount, userName, gameId });
      } catch {
        if (!cancelled) retry = setTimeout(() => void join(), Math.min(30_000, 2000 * 2 ** failures++));
      }
    };
    void join();
    return () => {
      cancelled = true;
      clearTimeout(retry);
      channel.current = null;
      useEmotes.getState().clear();
      usePresence.getState().clear();
      if (joined) api.chatLeave(joined).catch(() => undefined);
    };
    // The server removes chat membership on disconnect; every new login must join again.
  }, [gameId, live, loginCount, userName]);

  const send = (text: string) => {
    if (chatId && text.trim()) api.chatSendMessage(chatId, useSession.getState().userName, text.trim()).catch(() => undefined);
  };
  return { entries, send, ready: !!chatId, unread, clearUnread: () => setUnread(0) };
}

/** Recorded log lines, parsed once each however often the replay passes them. */
const parsedReplayLines = new WeakMap<ChatMessage, LogEntry | null>();
let replaySeq = 0;

function replayEntries(log: readonly ChatMessage[]): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const message of log) {
    let entry = parsedReplayLines.get(message);
    if (entry === undefined) {
      entry = parseChatMessage(message, `r${replaySeq++}`);
      parsedReplayLines.set(message, entry);
    }
    if (entry) entries.push(entry);
  }
  return entries.slice(-MAX_LINES);
}

export function GameLog({ gameId, notices, canChat, view, replayLog, delayMs = 0, seatDisplayNames }: {
  gameId: string;
  notices: GameNotice[];
  canChat: boolean;
  view: GameView | null;
  /** replays: the log up to the moment shown */
  replayLog?: readonly ChatMessage[];
  /** watching: the broadcast delay, which the log keeps too */
  delayMs?: number;
  seatDisplayNames?: SeatDisplayNames;
}) {
  const t = useT();
  const open = useMatchUi((state) => state.logOpen);
  const toggle = useMatchUi((state) => state.toggleLog);
  const muted = useEmotes((state) => !!state.muted[gameId]);
  const toggleMute = useEmotes((state) => state.toggleMute);
  const myName = useSession((state) => state.userName);
  const ignored = useSocial((state) => state.ignored);
  const live = useGameChat(gameId, view, !replayLog, delayMs);
  const recorded = useMemo(() => (replayLog ? replayEntries(replayLog) : null), [replayLog]);
  const chat = recorded ? { ...live, entries: recorded } : live;
  const [draft, setDraft] = useState('');
  const [pane, setPane] = useState<'chat' | 'log'>('chat');
  const showChat = canChat && pane === 'chat';
  const [pinned, setPinned] = useState(() => readJson(PINNED_KEY, false));
  const list = useRef<HTMLOListElement>(null);
  const drawer = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLDivElement>(null);
  // an open log closes on Escape or a click elsewhere on the table, unless it's pinned (#249)
  useEffect(() => {
    if (!open || pinned) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || matchKeysBlocked()) return;
      // the log takes this Escape: it doesn't also cancel the question on the table
      event.preventDefault();
      toggle(false);
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || drawer.current?.contains(target) || toggleRef.current?.contains(target)) return;
      // a card or viewer opened from the log is part of reading it
      if (target instanceof Element && target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      toggle(false);
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [open, pinned, toggle]);
  const pin = () => {
    writeJson(PINNED_KEY, !pinned);
    setPinned(!pinned);
  };
  // every card seen this game, so lines about cards that left the table can still show them
  const cards = useRef(new Map<string, CardView>());
  useEffect(() => {
    collectCards(view, cards.current);
  }, [view]);

  const rows = useMemo(() => {
    // the server's errors, and its messages to this player alone (why a block was refused, for one)
    const errors = notices.filter((notice) => notice.kind === 'error' || notice.kind === 'personal').map((notice) => noticeEntry(`n${notice.id}`, notice.text, notice.at));
    const blocked = new Set(ignored.map((name) => name.toLowerCase()));
    const heard = blocked.size > 0 ? chat.entries.filter((entry) => entry.tone !== 'chat' || !entry.who || !blocked.has(entry.who.toLowerCase())) : chat.entries;
    const visible = muted ? heard.filter((entry) => entry.tone !== 'chat' || entry.who === myName) : heard;
    // stable sort: lines from the same moment keep the order the server sent them in
    const entries = [...visible, ...errors].sort((a, b) => a.at - b.at);
    return buildLogRows(entries, myName);
  }, [chat.entries, notices, muted, myName, ignored]);

  useEffect(() => {
    if (open && showChat) chat.clearUnread();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, showChat, chat.unread]);

  const displayed = showChat ? rows.filter((row) => row.kind !== 'separator' && row.entry.tone === 'chat') : rows;
  const lastDisplayedKey = displayed.at(-1)?.key;
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [lastDisplayedKey, open, showChat]);

  const panelLabel = t(showChat ? 'match.chat.panel' : 'match.chat.logPanel');
  const onSend = () => {
    if (!chat.ready || !draft.trim()) return;
    chat.send(draft);
    setDraft('');
  };

  return (
    <>
      <div ref={toggleRef} className={styles.toggle}>
        <button type="button" className={styles.launcher} aria-expanded={open} onClick={() => { if (!open) setPane('chat'); toggle(); }}>
          {canChat ? <MessageSquare aria-hidden="true" /> : <BookOpen aria-hidden="true" />}
          {t(canChat ? 'match.chat.title' : 'match.chat.log')}
        </button>
        {chat.unread > 0 && (!open || !showChat) && <span className={styles.badge} aria-hidden="true">{chat.unread}</span>}
      </div>
      {open && (
        <aside ref={drawer} className={[styles.drawer, showChat ? styles.chatDrawer : ''].join(' ')} aria-label={panelLabel}>
          <header className={styles.head}>
            {canChat ? (
              <div className={styles.panes}>
                <button type="button" aria-pressed={showChat} onClick={() => setPane('chat')}>{t('match.chat.title')}</button>
                <button type="button" aria-pressed={!showChat} onClick={() => setPane('log')}>{t('match.chat.log')}</button>
              </div>
            ) : <h2>{t('match.chat.log')}</h2>}
            <div className={styles.headActions}>
              {canChat && (
                <button type="button" className={styles.mute} aria-pressed={muted} onClick={() => toggleMute(gameId)}>
                  {muted ? 'Unmute opponent' : 'Mute opponent'}
                </button>
              )}
              <IconButton
                label={pinned ? 'Unpin the log: a click elsewhere or Escape closes it' : 'Pin the log open while you play'}
                icon={pinned ? <PinOff size={20} /> : <Pin size={20} />}
                pressed={pinned}
                onClick={pin}
              />
              <IconButton label={t('match.chat.close')} icon={<X size={20} />} onClick={() => toggle(false)} />
            </div>
          </header>
          <ol ref={list} className={styles.lines} aria-live={showChat ? 'polite' : undefined}>
            {displayed.length === 0 && <li className={styles.empty}>{t(showChat ? 'match.chat.empty' : 'match.chat.emptyLog')}</li>}
            {displayed.map((row) => (row.kind === 'separator'
              ? (
                <li key={row.key} className={[styles.separator, row.mine ? styles.separatorMine : ''].join(' ')}>
                  <span>Turn {row.turn}{row.player ? ` · ${row.mine ? 'You' : seatDisplayName(row.player, seatDisplayNames)}` : ''}</span>
                </li>
              )
              : <LogLine key={row.key} entry={row.entry} cards={cards} seatDisplayNames={seatDisplayNames} />))}
          </ol>
          {showChat && (
            <footer className={styles.foot}>
              <div className={styles.emotes}>
                {EMOTES.map((emote) => (
                  <button key={emote} type="button" className={styles.emote} onClick={() => chat.send(emote)} disabled={!chat.ready}>{emote}</button>
                ))}
              </div>
              <form
                className={styles.form}
                onSubmit={(event) => {
                  event.preventDefault();
                  onSend();
                }}
              >
                <input
                  className={styles.input}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={t(chat.ready ? 'match.chat.placeholder' : 'match.chat.joining')}
                  disabled={!chat.ready}
                  aria-label={t('match.chat.message')}
                  maxLength={400}
                />
                <button type="submit" className={styles.send} disabled={!chat.ready || !draft.trim()}>{t('match.chat.send')}</button>
              </form>
            </footer>
          )}
        </aside>
      )}
    </>
  );
}

const LogLine = memo(function LogLine({ entry, cards, seatDisplayNames }: {
  entry: LogEntry; cards: { current: Map<string, CardView> }; seatDisplayNames?: SeatDisplayNames;
}) {
  const Icon = ICONS[entry.icon];
  // the rule behind a game line, on request (S009)
  const notes = useMemo(() => (entry.tone === 'game' ? explainLog(entry.text) : []), [entry.tone, entry.text]);
  const [open, setOpen] = useState(false);
  return (
    <li className={[styles.line, styles[entry.tone]].join(' ')}>
      <Icon className={[styles.icon, styles[`icon_${entry.icon}`] ?? ''].join(' ')} size={16} aria-hidden="true" />
      <span className={styles.body}>
        {entry.who && <b>{seatDisplayName(entry.who, seatDisplayNames)}: </b>}
        {entry.tone === 'chat' ? entry.text : entry.segments.map((segment, index) => <Segment key={index} segment={segment} cards={cards} seatDisplayNames={seatDisplayNames} />)}
        {notes.length > 0 && (
          <button
            type="button"
            className={styles.why}
            aria-expanded={open}
            aria-label={open ? 'Hide the rule behind this' : 'Why did that happen?'}
            title="Why did that happen?"
            onClick={() => setOpen((value) => !value)}
          >
            <HelpCircle size={13} aria-hidden="true" />
          </button>
        )}
        {open && notes.map((note) => (
          <span key={note.id} className={styles.rule}>
            <b>{note.title}</b>
            {note.rule !== '—' && <small> · rule {note.rule}</small>}
            <span>{note.text}</span>
          </span>
        ))}
      </span>
    </li>
  );
});

function Segment({ segment, cards, seatDisplayNames }: {
  segment: LogSegment; cards: { current: Map<string, CardView> }; seatDisplayNames?: SeatDisplayNames;
}) {
  const setZoom = useMatchUi((state) => state.setZoom);
  const openDetail = useMatchUi((state) => state.openDetail);
  if (segment.kind === 'text') return <PromptText text={segment.text} />;
  if (segment.kind === 'player') return <span className={styles.player}>{seatDisplayName(segment.name, seatDisplayNames)}</span>;
  // looked up when used: the card may have moved since the line was written
  const find = () => findLogCard(cards.current, segment);
  return (
    <button
      type="button"
      className={[styles.card, styles[`ink_${cardInk(segment.color) ?? 'none'}`] ?? ''].join(' ')}
      onPointerEnter={(event) => {
        const card = find();
        if (card) setZoom({ card, x: event.clientX, y: event.clientY, anchor: event.currentTarget });
      }}
      onPointerLeave={() => setZoom(null)}
      onClick={() => {
        const card = find();
        if (card?.id) openDetail({ id: card.id, card });
      }}
      aria-label={`${segment.name}, show card`}
    >
      {segment.name}
    </button>
  );
}
