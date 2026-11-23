import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useStore } from 'zustand';
import { GameSession } from '../../core/game/gameSession';
import { EventBus } from '../../core/rpc/EventBus';
import { createApi } from '../../protocol/generated/api';
import type { CardView, GameView } from '../../protocol/generated/views';
import { useT } from '../i18n';
import { MatchStage } from '../match/MatchStage';
import { spectatorFeed, type SpectatorLine, type SpectatorChatMessage } from '../match/spectatorFeed';
import { Button, ButtonLink } from '../ui/Button';
import { MatchHumanSeat } from '../ui/humanSeat';
import type { SeatDisplayNames } from '../match/seatDisplayNames';
import { PublicBroadcast } from '../ui/usePlayerIdentity';
import { SeatKnowledge, type KnownCards } from './SeatKnowledge';
import { SpectatorFrame } from './SpectatorFrame';
import { SpectatorLink } from './SpectatorLink';
import styles from './SpectatorBoard.module.css';

export interface SpectatorSnapshot {
  role: 'spectator';
  visibility?: 'public-board' | 'both-hands';
  seatKnowledge?: Record<string, KnownCards>;
  gameId: string | null;
  rollbackRevision?: number;
  status: 'waiting' | 'playing' | 'between_games' | 'finished';
  view: GameView | null;
  hands: Record<string, Record<string, CardView>>;
  humanMcpName?: string;
  players: { playerId: string; name: string; displayName?: string }[];
  lines: SpectatorLine[];
  chat: SpectatorChatMessage[];
  spectators: number;
}

const offlineApi = createApi({ async call() { throw new Error('Spectator sessions cannot send game commands'); } });
const noEvents = { onEvent: () => () => {}, onSessionStart: () => () => {}, onStatus: () => () => {} };

export function ProjectedBoard({ frame, gameId, seatDisplayNames }: { frame: SpectatorSnapshot; gameId: string; seatDisplayNames?: SeatDisplayNames }) {
  const session = useMemo(() => new GameSession(offlineApi, new EventBus(noEvents), { gameId, playerId: null, mode: 'watch' }), [gameId]);
  useEffect(() => () => session.dispose(), [session]);
  useLayoutEffect(() => {
    if (frame.view) session.showFrame(frame.view, frame.players[0]?.playerId ?? null);
  }, [frame, session]);
  const state = useStore(session.store);
  const broadcast = useMemo(() => ({ events: spectatorFeed(gameId, frame.lines, frame.chat, frame.visibility), publicBoardOnly: frame.visibility === 'public-board' }), [gameId, frame.lines, frame.chat, frame.visibility]);
  const aliases = useMemo(() => ({ ...seatDisplayNames, ...Object.fromEntries(frame.players.flatMap(player =>
    player.displayName ? [[player.name, player.displayName]] : [])) }), [frame.players, seatDisplayNames]);
  return <MatchStage state={state} session={session} replayHands={frame.visibility === 'public-board' ? {} : frame.hands} publicSpectator={broadcast} seatDisplayNames={aliases} />;
}

type BroadcastState = { frame: SpectatorSnapshot; problem?: never; closedPath?: never }
  | { frame?: never; problem: 'loading' | 'missing' | 'error'; closedPath?: never }
  | { frame?: never; problem?: never; closedPath: string };

function parseSnapshot(raw: unknown): BroadcastState {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid broadcast');
  if ('visibility' in raw && raw.visibility === 'closed') {
    if (!('role' in raw && raw.role === 'spectator' && 'status' in raw && raw.status === 'finished'
      && 'publicPath' in raw && typeof raw.publicPath === 'string' && /^\/watch\/[A-Za-z0-9_-]+$/.test(raw.publicPath))) {
      return { problem: 'missing' };
    }
    return { closedPath: raw.publicPath };
  }
  const data = raw as Partial<SpectatorSnapshot>;
  if (data.role !== 'spectator' || !['waiting', 'playing', 'between_games', 'finished'].includes(data.status ?? '')
    || (data.visibility !== undefined && data.visibility !== 'both-hands' && data.visibility !== 'public-board')
    || !Array.isArray(data.players) || !data.hands) throw new Error('Invalid broadcast');
  return { frame:data as SpectatorSnapshot };
}

function useBroadcast(endpoint: string, refresh: number) {
  const [state, setState] = useState<BroadcastState>({ problem: 'loading' });
  useEffect(() => {
    const abort = new AbortController();
    let stream: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout>;
    function retry() {
      stream?.close();
      clearTimeout(timer);
      if (!abort.signal.aborted) timer = setTimeout(() => void load(), 2500);
    }
    async function load() {
      try {
        const response = await fetch(endpoint, { cache: 'no-store', signal: abort.signal });
        if (abort.signal.aborted) return;
        if ([401, 403, 404, 410].includes(response.status)) {
          setState({ problem: 'missing' });
          return;
        }
        if (!response.ok) throw new Error('Broadcast unavailable');
        const next = parseSnapshot(await response.json());
        if (abort.signal.aborted) return;
        setState(next);
        if (next.frame?.status === 'finished' || !next.frame) return;
        if (typeof EventSource === 'undefined') { retry(); return; }
        const [path, search] = endpoint.split('?');
        stream = new EventSource(path + '/events' + (search ? '?' + search : ''));
        stream.addEventListener('snapshot', event => {
          if (abort.signal.aborted) return;
          try {
            const next = parseSnapshot(JSON.parse(event.data));
            setState(next);
            if (next.frame?.status === 'finished' || !next.frame) stream?.close();
          } catch { setState({ problem: 'error' }); retry(); }
        });
        stream.onerror = retry;
      } catch {
        if (!abort.signal.aborted) { setState({ problem: 'error' }); retry(); }
      }
    }
    void load();
    return () => { abort.abort(); stream?.close(); clearTimeout(timer); };
  }, [endpoint, refresh]);
  return state;
}

export function SpectatorBroadcast({ endpoint, tableId, path, onLeave, humanMcpName, seatDisplayNames, actions }: {
  endpoint: string; tableId?: string; path?: string; onLeave?: () => void;
  humanMcpName?: string | null; seatDisplayNames?: SeatDisplayNames; actions?: ReactNode;
}) {
  const t = useT();
  const [refresh, setRefresh] = useState(0);
  const { frame, problem, closedPath } = useBroadcast(endpoint, refresh);
  const status = [frame?.visibility === 'both-hands' && t('watch.bothScope'), tableId && t('match.input.delegated'), frame && t(`watch.${frame.status}`),
    frame && t('watch.viewers', { count: frame.spectators })].filter(Boolean).join(' · ');
  return <PublicBroadcast.Provider value><MatchHumanSeat.Provider value={(frame?.humanMcpName || humanMcpName)?.toLowerCase() ?? null}><SpectatorFrame status={status} actions={<>
    {frame?.visibility === 'both-hands' && frame.seatKnowledge && <SeatKnowledge players={frame.players} knowledge={frame.seatKnowledge} />}
    {frame && (path || tableId) && !(path && frame.visibility === 'both-hands') && <SpectatorLink bothHands={frame.visibility === 'both-hands'} tableId={tableId} path={path} publicBoard={frame.visibility === 'public-board'} />}
    {actions}
    {onLeave && <Button variant="quiet" size="sm" onClick={onLeave}>{t('career.backToPlay')}</Button>}
  </>}>
    {frame?.view && frame.gameId ? <ProjectedBoard key={`${frame.gameId}:${frame.rollbackRevision ?? 0}`} frame={frame} gameId={frame.gameId} seatDisplayNames={seatDisplayNames} />
      : <div className={styles.empty} role="status">
        {closedPath ? <>{t('watch.expandedEnded')}<ButtonLink href={closedPath}>{t('watch.openPublic')}</ButtonLink></>
          : t(problem ? `watch.${problem}` : `watch.${frame!.status}`)}
        {problem === 'error' && <Button onClick={() => setRefresh(value => value + 1)}>{t('watch.retry')}</Button>}
      </div>}
  </SpectatorFrame></MatchHumanSeat.Provider></PublicBroadcast.Provider>;
}

export function SpectatorScreen() {
  const token = encodeURIComponent(useParams().token ?? '');
  return <SpectatorBroadcast key={token} endpoint={'/api/playtesting/spectate/' + token} path={'/watch/' + token} />;
}
