import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useStore } from 'zustand';
import { GameSession } from '../../core/game/gameSession';
import { EventBus } from '../../core/rpc/EventBus';
import { createApi } from '../../protocol/generated/api';
import type { CardView, GameView } from '../../protocol/generated/views';
import { useT } from '../i18n';
import { MatchStage } from '../match/MatchStage';
import { spectatorFeed, type SpectatorLine, type SpectatorChatMessage } from '../match/spectatorFeed';
import { Button } from '../ui/Button';
import { MatchHumanSeat } from '../ui/humanSeat';
import type { SeatDisplayNames } from '../match/seatDisplayNames';
import { PublicBroadcast } from '../ui/usePlayerIdentity';
import { SpectatorFrame } from './SpectatorFrame';
import { SpectatorLink } from './SpectatorLink';
import styles from './SpectatorBoard.module.css';

interface Snapshot {
  role: 'spectator';
  gameId: string | null;
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

function ProjectedBoard({ frame, gameId, seatDisplayNames }: { frame: Snapshot; gameId: string; seatDisplayNames?: SeatDisplayNames }) {
  const session = useMemo(() => new GameSession(offlineApi, new EventBus(noEvents), { gameId, playerId: null, mode: 'watch' }), [gameId]);
  useEffect(() => () => session.dispose(), [session]);
  useLayoutEffect(() => {
    if (frame.view) session.showFrame(frame.view, frame.players[0]?.playerId ?? null);
  }, [frame, session]);
  const state = useStore(session.store);
  const broadcast = useMemo(() => ({ events: spectatorFeed(gameId, frame.lines, frame.chat) }), [gameId, frame.lines, frame.chat]);
  const aliases = useMemo(() => ({ ...seatDisplayNames, ...Object.fromEntries(frame.players.flatMap(player =>
    player.displayName ? [[player.name, player.displayName]] : [])) }), [frame.players, seatDisplayNames]);
  return <MatchStage state={state} session={session} replayHands={frame.hands} publicSpectator={broadcast} seatDisplayNames={aliases} />;
}

function parseSnapshot(raw: unknown): Snapshot {
  const data = raw as Partial<Snapshot> | null;
  if (data?.role !== 'spectator' || !['waiting', 'playing', 'between_games', 'finished'].includes(data.status ?? '')
    || !Array.isArray(data.players) || !data.hands) throw new Error('Invalid broadcast');
  return data as Snapshot;
}

type BroadcastState = { frame: Snapshot; problem?: never } | { frame?: never; problem: 'loading' | 'missing' | 'error' };

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
        const frame = parseSnapshot(await response.json());
        if (abort.signal.aborted) return;
        setState({ frame });
        if (frame.status === 'finished') return;
        if (typeof EventSource === 'undefined') { retry(); return; }
        stream = new EventSource(endpoint + '/events');
        stream.addEventListener('snapshot', event => {
          if (abort.signal.aborted) return;
          try {
            const frame = parseSnapshot(JSON.parse(event.data));
            setState({ frame });
            if (frame.status === 'finished') stream?.close();
          } catch { retry(); }
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

export function SpectatorBroadcast({ endpoint, tableId, path, onLeave, humanMcpName, seatDisplayNames }: {
  endpoint: string; tableId?: string; path?: string; onLeave?: () => void;
  humanMcpName?: string | null; seatDisplayNames?: SeatDisplayNames;
}) {
  const t = useT();
  const [refresh, setRefresh] = useState(0);
  const { frame, problem } = useBroadcast(endpoint, refresh);
  const status = [tableId && t('match.input.delegated'), frame && t(`watch.${frame.status}`),
    frame && t('watch.viewers', { count: frame.spectators })].filter(Boolean).join(' · ');
  return <PublicBroadcast.Provider value><MatchHumanSeat.Provider value={(frame?.humanMcpName || humanMcpName)?.toLowerCase() ?? null}><SpectatorFrame status={status} actions={<>
    {problem !== 'missing' && <SpectatorLink tableId={tableId} path={path} />}
    {onLeave && <Button variant="quiet" size="sm" onClick={onLeave}>{t('career.backToPlay')}</Button>}
  </>}>
    {frame?.view && frame.gameId ? <ProjectedBoard key={frame.gameId} frame={frame} gameId={frame.gameId} seatDisplayNames={seatDisplayNames} />
      : <div className={styles.empty} role="status">
        {t(problem ? `watch.${problem}` : `watch.${frame!.status}`)}
        {problem === 'error' && <Button onClick={() => setRefresh(value => value + 1)}>{t('watch.retry')}</Button>}
      </div>}
  </SpectatorFrame></MatchHumanSeat.Provider></PublicBroadcast.Provider>;
}

export function SpectatorScreen() {
  const token = encodeURIComponent(useParams().token ?? '');
  return <SpectatorBroadcast key={token} endpoint={'/api/playtesting/spectate/' + token} path={'/watch/' + token} />;
}
