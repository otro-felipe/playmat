import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { ChevronFirst, ChevronLast, GitBranch, Pause, Play, StepBack, StepForward } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useStore } from 'zustand';
import { GameSession } from '../../core/game/gameSession';
import { EventBus } from '../../core/rpc/EventBus';
import { appendEvents, EMPTY_TIMELINE, frameDelay, frameIndexAt, logsAt, turnJump, viewAt, type ReplayTimeline } from '../../core/replay/timeline';
import type { ReplayInfo } from '../../protocol/generated/views';
import { api } from '../connection';
import { useT } from '../i18n';
import { MatchErrorBoundary } from '../match/MatchErrorBoundary';
import { MatchStage } from '../match/MatchStage';
import { useMatchUi } from '../match/matchUi';
import { PRIVATE_PLAYTESTING } from '../playtesting';
import { playFromTurn, useSoloTurns } from '../solo/soloData';
import { useSession } from '../stores/session';
import { notify } from '../stores/toasts';
import { Button, IconButton } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { ReplayReviewPanel, ReviewSwitch, type ReviewMoment } from './ReplayReviewPanel';
import { changeLegacyPermission, frameProjection, loadReviewAnnotations, loadReviewEvents, loadReviewManifest, loadReviewPlays, perspectivesFor } from './reviewData';
import styles from './ReplayScreen.module.css';

/** events asked for at a time: snapshots are large, so pages stay small and the replay starts early */
const PAGE_SIZE = 40;
const SPEEDS = [0.5, 1, 2, 4];
const FRAME_PAGE_SIZE = 16;
const MOBILE_PANEL = '(max-width: 960px), (max-height: 560px)';

function subscribePanelSize(onChange: () => void) {
  const media = window.matchMedia(MOBILE_PANEL);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

/** a replay has no live connection: its session is fed snapshots by hand */
const NO_EVENTS = {
  onEvent: () => () => undefined,
  onSessionStart: () => () => undefined,
  onStatus: () => () => undefined,
};

/** Plays a recorded game back on the match stage: play, pause, step, jump by turn, scrub and change speed. */
export function ReplayScreen() {
  const { gameId = '' } = useParams();
  const userName = useSession((state) => state.phase === 'signedIn' ? state.userName : '');
  return <ReplayPlayer key={JSON.stringify([gameId, userName])} gameId={gameId} userName={userName} />;
}

function ReplayPlayer({ gameId, userName }: { gameId: string; userName: string }) {
  const t = useT();
  const navigate = useNavigate();
  // a review links to a moment: open there, paused
  const [search, setSearch] = useSearchParams();
  const [startFrame] = useState(() => Number.parseInt(search.get('frame') ?? '', 10));
  const [action, setAction] = useState<number | undefined>(() => {
    const cursor = search.get('cursor');
    return cursor && /^\d+$/.test(cursor) ? Number(cursor) : undefined;
  });
  const [timeline, setTimeline] = useState<ReplayTimeline>(EMPTY_TIMELINE);
  const [info, setInfo] = useState<ReplayInfo | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameIndex, setFrameIndex] = useState(() => Number.isFinite(startFrame) ? Math.max(0, startFrame) : 0);
  const [playing, setPlaying] = useState(action === undefined && !Number.isFinite(startFrame));
  const [speed, setSpeed] = useState(1);
  const [analysisOpen, setAnalysisOpen] = useState(() => search.get('analysis') === '1');
  const [bothHands, setBothHands] = useState(false);
  const [requestedSeat, setRequestedSeat] = useState<string>();
  const mobilePanel = useSyncExternalStore(subscribePanelSize, () => window.matchMedia(MOBILE_PANEL).matches, () => false);
  const panelId = useId();
  const toolbarRef = useRef<HTMLDivElement>(null);
  const session = useMemo(() => new GameSession(api, new EventBus(NO_EVENTS), { gameId, playerId: null, mode: 'replay' }), [gameId]);
  useEffect(() => () => session.dispose(), [session]);
  const state = useStore(session.store);

  // pages come in one after the other; playback starts with the first
  useEffect(() => {
    let cancelled = false;
    if (PRIVATE_PLAYTESTING && !userName) return;
    void (async () => {
      let current = EMPTY_TIMELINE;
      for (;;) {
        const page = await api.replayPage(gameId, current.read, PAGE_SIZE);
        if (cancelled) return;
        if (!page) {
          setError('This replay is not on the server any more.');
          return;
        }
        current = appendEvents(current, page.events ?? []);
        setInfo(page.info);
        setTotal(page.total);
        setTimeline(current);
        if ((page.events ?? []).length === 0 || current.read >= page.total) return;
      }
    })().catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      cancelled = true;
    };
  }, [gameId, userName]);

  const manifestQuery = useQuery({
    queryKey: ['match-review', userName, gameId, 'manifest'],
    queryFn: ({ signal }) => loadReviewManifest(gameId, signal),
    enabled: PRIVATE_PLAYTESTING && !!userName,
    gcTime: 0,
    retry: false,
  });
  const manifest = manifestQuery.data;
  const privacy = manifest?.privacy;
  const canGrantLegacy = privacy?.canGrantLegacy ?? manifest?.canGrantLegacy;
  const legacyGranted = privacy?.legacyGranted ?? manifest?.legacyGranted;
  const perspectives = perspectivesFor(manifest);
  const viewerSeat = privacy?.viewerSeatId ?? manifest?.viewerSeatId;
  const perspective = perspectives.find((seat) => seat.seatId === requestedSeat)
    ?? perspectives.find((seat) => seat.seatId === viewerSeat || seat.owned);
  const showBoth = bothHands && (privacy?.fullAvailable ?? manifest?.fullAvailable) === true;
  const otherSeat = !!perspective && perspective.seatId !== viewerSeat && !perspective.owned;
  const scope = showBoth ? 'full' : manifest ? 'seat' : null;

  const eventQuery = useInfiniteQuery({
    queryKey: ['match-review', userName, gameId, 'plays', manifest?.archiveRevision],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => loadReviewPlays(gameId, pageParam, signal),
    getNextPageParam: (page) => page?.next ?? undefined,
    enabled: !!manifest,
    gcTime: 0,
  });
  const annotations = useInfiniteQuery({
    queryKey: ['match-review', userName, gameId, 'annotations', manifest?.archiveRevision, privacy?.fullAvailable ?? manifest?.fullAvailable],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => loadReviewAnnotations(gameId, pageParam, signal),
    getNextPageParam: (page) => page?.next ?? undefined,
    enabled: !!manifest,
    gcTime: 0,
  });
  const allAnnotations = useMemo(() => (annotations.data?.pages ?? []).flatMap((page) => page?.annotations ?? []), [annotations.data]);
  const events = useMemo(() => (eventQuery.data?.pages ?? []).flatMap((page) => page?.events ?? []), [eventQuery.data]);
  const plays = useMemo(() => events.flatMap((event): ReviewMoment[] => {
    const content = event.text ?? event.actual?.text ?? event.log?.message;
    return event.type === 'action' && event.frameCursor != null && content ? [{ ...event, text: content }] : [];
  }), [events]);
  const moments = useMemo(() => [...new Map(allAnnotations.map((annotation) => [annotation.cursor, {
    cursor: annotation.cursor, frameCursor: annotation.frameCursor, text: annotation.actual.text, turn: annotation.evidence?.turn,
  }])).values()].sort((a, b) => a.cursor - b.cursor), [allAnnotations]);

  const selectedAnnotation = useQuery({
    queryKey: ['match-review', userName, gameId, 'annotations-at', action, manifest?.archiveRevision, privacy?.fullAvailable ?? manifest?.fullAvailable],
    queryFn: ({ signal }) => loadReviewAnnotations(gameId, action!, signal),
    enabled: !!manifest && action !== undefined && !allAnnotations.some((item) => item.cursor === action),
    gcTime: 0,
  });
  const contextualAnnotations = allAnnotations.some((item) => item.cursor === action) ? allAnnotations : selectedAnnotation.data?.annotations;
  const chosen = contextualAnnotations?.find((item) => item.cursor === action && item.seatId === perspective?.seatId)
    ?? contextualAnnotations?.find((item) => item.cursor === action);
  const anchor = action === undefined ? undefined : chosen?.frameCursor ?? plays.find((item) => item.cursor === action)?.frameCursor ?? action;

  const frames = timeline.frames;
  const loaded = total !== null && timeline.read >= total;
  const last = Math.max(0, frames.length - 1);
  const index = anchor === undefined ? frameIndex : frameIndexAt(timeline, anchor);
  const frame = frames[Math.min(index, last)] ?? null;
  const ownSeat = useMemo(
    () => frames[0]?.view.players?.find((player) => player.name === userName)?.playerId ?? null,
    [frames, userName],
  );

  const orient = perspective?.playerId ?? frame?.view.players?.find((player) => player.name === perspective?.name)?.playerId;
  const playerId = orient ?? state.playerId ?? ownSeat;
  const frameCursor = frame?.cursor ?? 0;
  const batchCursor = Math.max(0, Math.floor(frameCursor / FRAME_PAGE_SIZE) * FRAME_PAGE_SIZE - 1);
  const privateFrameQuery = useQuery({
    queryKey: ['match-review', userName, gameId, 'private-frame', scope, perspective?.seatId, batchCursor, manifest?.archiveRevision],
    queryFn: ({ signal }) => loadReviewEvents(gameId, batchCursor, scope!, FRAME_PAGE_SIZE + 1, signal,
      scope === 'seat' && otherSeat ? perspective?.seatId : undefined),
    enabled: !!scope && !!frame,
    gcTime: 0,
    retry: false,
  });
  const recorded = scope ? privateFrameQuery.data?.events.find((item) => item.cursor === frameCursor && item.view) : undefined;
  const projection = useMemo(() => {
    if (!frame) return null;
    const ownPerspective = !!ownSeat && ownSeat === playerId;
    if (!manifest) return { view: viewAt(frame, ownPerspective), hands: undefined };
    return frameProjection(frame.view, playerId, !otherSeat && ownPerspective ? frame.myHand : null, recorded, showBoth);
  }, [frame, playerId, ownSeat, otherSeat, recorded, showBoth, manifest]);

  useLayoutEffect(() => {
    if (projection) session.showFrame(projection.view, playerId);
  }, [projection, playerId, session]);

  useLayoutEffect(() => {
    if (manifest) useMatchUi.setState({ zoom: null, detail: null, viewer: null });
  }, [manifest, scope, perspective?.seatId, frameCursor]);

  const legacyPermission = useMutation({
    mutationFn: (granted: boolean) => changeLegacyPermission(manifest!.matchId, granted),
    onMutate: () => {
      setBothHands(false);
      setRequestedSeat(undefined);
    },
    onSuccess: () => {
      const account = useSession.getState();
      if (account.phase === 'signedIn' && account.userName === userName) return manifestQuery.refetch();
    },
  });

  // playback: wait out the frame, then move on; at the end, wait for more pages or stop
  useEffect(() => {
    if (!playing || frames.length === 0) return;
    if (index >= frames.length - 1) {
      if (loaded) setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setFrameIndex((current) => current + 1), frameDelay(timeline, index, speed));
    return () => clearTimeout(timer);
  }, [playing, index, speed, timeline, frames.length, loaded]);

  function go(next: number) {
    setAction(undefined);
    setFrameIndex(Math.max(0, Math.min(last, next)));
    setPlaying(false);
  }

  function jump(moment: ReviewMoment) {
    setPlaying(false);
    setAction(moment.cursor);
    setSearch((prior) => {
      const query = new URLSearchParams(prior);
      query.set('cursor', String(moment.cursor));
      query.delete('frame');
      return query;
    }, { replace: true });
  }

  const currentCursor = action ?? frameCursor;
  const previousPlay = plays.filter((item) => item.cursor < currentCursor).at(-1);
  const nextPlay = plays.find((item) => item.cursor > currentCursor);
  const previousMoment = moments.filter((item) => item.cursor < currentCursor).at(-1);
  const nextMoment = moments.find((item) => item.cursor > currentCursor);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey
        || target?.closest('button, input, select, textarea, a, [contenteditable="true"], [role="dialog"]')) return;
      if (event.key === ' ') {
        event.preventDefault();
        if (!playing) {
          setFrameIndex(index >= last && loaded ? 0 : index);
          setAction(undefined);
        }
        setPlaying((current) => !current);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        setPlaying(false);
        setAction(undefined);
        setFrameIndex(event.shiftKey ? turnJump(timeline, index, 1) : Math.min(last, index + 1));
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setPlaying(false);
        setAction(undefined);
        setFrameIndex(event.shiftKey ? turnJump(timeline, index, -1) : Math.max(0, index - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [timeline, last, index, loaded, playing]);

  // your own games against the computer keep every turn: take over from the start of one (S014)
  const turns = useSoloTurns(gameId);
  const kept = useMemo(() => new Set((turns.data ?? []).map((entry) => entry.turn)), [turns.data]);
  async function takeOver(turn: number) {
    setPlaying(false);
    try {
      await playFromTurn(gameId, turn);
    } catch (failure) {
      notify('Play from here', failure instanceof Error ? failure.message : String(failure));
    }
  }

  const replayLog = useMemo(() => logsAt(timeline, Math.min(index, last)), [timeline, index, last]);
  const leave = () => navigate('/history');

  if (error) {
    return (
      <div className={styles.missing}>
        <h1>Can't play this replay</h1>
        <p>{error}</p>
        <Button variant="print" onClick={leave}>Back to History</Button>
      </div>
    );
  }
  if (!frame) {
    return (
      <div className={styles.missing}>
        <p role="status">Loading the replay…</p>
      </div>
    );
  }

  const turn = frame.view.turn ?? 0;
  const canShowBoth = (privacy?.fullAvailable ?? manifest?.fullAvailable) === true;
  const partialArchive = info?.truncated || manifest?.coverage?.partial === true || Object.values(manifest?.coverage ?? {}).some((entry) =>
    entry === 'partial' || entry === 'missing' || typeof entry === 'object' && entry.status === 'partial');
  const shownHand = showBoth ? recorded?.hands : recorded?.myHand ?? recorded?.view?.myHand;
  const previousFrameCursor = frames[Math.min(index, last) - 1]?.cursor ?? -1;
  const draws = privateFrameQuery.data?.events.filter((event) =>
    event.type === 'draw' && event.card?.name && event.cursor > previousFrameCursor && event.cursor <= frameCursor) ?? [];
  const viewStatus = (showBoth || otherSeat) && (privateFrameQuery.isError ? t('replay.privateFrameError')
    : privateFrameQuery.isPending ? t('replay.privateFrameLoading') : !shownHand ? t('replay.privateFrameMissing') : null);
  const reviewError = annotations.isError || eventQuery.isError;
  const fetchMore = () => {
    if (annotations.hasNextPage) void annotations.fetchNextPage();
    if (eventQuery.hasNextPage) void eventQuery.fetchNextPage();
  };
  const setAnalysis = (open: boolean) => {
    setPlaying(false);
    setAnalysisOpen(open);
    if (!open && mobilePanel) requestAnimationFrame(() => toolbarRef.current?.querySelector<HTMLButtonElement>('[role="switch"]')?.focus());
  };
  const panel = manifest && analysisOpen && <ReplayReviewPanel analysis={manifest.analysis} moments={moments} current={action}
    annotation={chosen} actor={perspectives.find((seat) => seat.seatId === chosen?.seatId)?.name}
    showRetrospective={showBoth && !!recorded} onMoment={jump} error={reviewError}
    onRetry={() => { void eventQuery.refetch(); void annotations.refetch(); }}
    onPrevious={previousMoment ? () => jump(previousMoment) : undefined} onNext={nextMoment ? () => jump(nextMoment) : undefined}
    more={annotations.hasNextPage || eventQuery.hasNextPage ? { pending: annotations.isFetchingNextPage || eventQuery.isFetchingNextPage, load: fetchMore } : undefined} />;
  return (
    <MatchErrorBoundary gameId={gameId} backLabel="Back to History" onBack={leave}>
      <div className={manifest ? styles.review : undefined} data-panel={manifest && analysisOpen && !mobilePanel ? 'open' : undefined} data-replay-cursor={currentCursor}>
        <div className={manifest ? styles.table : undefined}>
          {manifest && (
            <div ref={toolbarRef} className={styles.reviewToolbar}>
              <div className={styles.reviewControls}>
                <ReviewSwitch label={t('replay.showAnalysis')} checked={analysisOpen} onCheckedChange={setAnalysis}
                  controls={analysisOpen && !mobilePanel ? panelId : undefined} />
                {canShowBoth && <ReviewSwitch label={t('replay.showBothHands')} checked={showBoth}
                  onCheckedChange={(checked) => { setPlaying(false); setBothHands(checked); }} />}
                {!!perspectives.length && (
                  <label className={styles.perspective}>
                    {t('replay.perspective')}
                    <select value={perspective?.seatId ?? ''} onChange={(event) => { setPlaying(false); setRequestedSeat(event.target.value); }}>
                      {perspectives.map((seat) => <option key={seat.seatId} value={seat.seatId}>{seat.name}</option>)}
                    </select>
                  </label>
                )}
              </div>
              {viewStatus && <p className={styles.coverage} role="status">{viewStatus}</p>}
              {partialArchive && <p className={styles.coverage}>{t('replay.partialArchive')}</p>}
              {manifest.status === 'active' && <p className={styles.coverage}>{t('replay.matchActive')}</p>}
              {canGrantLegacy && (
                <div className={styles.legacyPermission}>
                  <p>{t('replay.legacyNotice')}</p>
                  {legacyGranted && !canShowBoth && <p role="status">{t('replay.legacyPending')}</p>}
                  {legacyPermission.isError && <p role="alert">{t('replay.legacyError')}</p>}
                  <Button size="sm" variant="quiet" busy={legacyPermission.isPending}
                    onClick={() => legacyPermission.mutate(!legacyGranted)}>
                    {t(legacyGranted ? 'replay.legacyRevoke' : 'replay.legacyGrant')}
                  </Button>
                </div>
              )}
            </div>
          )}
          <div className={manifest ? styles.board : undefined}>
            <MatchStage session={session} state={state} replayHands={projection?.hands} reviewLayout={!!manifest} replayLog={replayLog} onLeave={leave} />
            {!!draws.length && (
              <ul className={styles.recordedDraws} aria-label={t('replay.draws')}>
                {draws.flatMap(({ actorPlayerId, card, cursor }) => {
                  const name = frame.view.players?.find((player) => player.playerId === actorPlayerId)?.name;
                  return name && card?.name ? [<li key={cursor}>{t('replay.drawn', { name, cards: card.name })}</li>] : [];
                })}
              </ul>
            )}
            {manifestQuery.isError && <div className={styles.reviewFailure} role="alert">
              {t('replay.reviewError')} <Button size="sm" variant="quiet" onClick={() => void manifestQuery.refetch()}>{t('replay.retry')}</Button>
            </div>}
            <div className={styles.transport} role="toolbar" aria-label="Replay controls">
              <IconButton label="Previous turn" icon={<ChevronFirst size={18} />} onClick={() => go(turnJump(timeline, index, -1))} />
              <IconButton label={manifest ? t('replay.previousPlay') : 'Step back'} icon={<StepBack size={18} />}
                onClick={() => previousPlay ? jump(previousPlay) : go(index - 1)} disabled={!previousPlay && index === 0} />
              <IconButton label={playing ? 'Pause' : 'Play'} icon={playing ? <Pause size={18} /> : <Play size={18} />} pressed={playing} onClick={() => {
                if (!playing) {
                  setFrameIndex(index >= last && loaded ? 0 : index);
                  setAction(undefined);
                }
                setPlaying(!playing);
              }} />
              <IconButton label={manifest ? t('replay.nextPlay') : 'Step forward'} icon={<StepForward size={18} />}
                onClick={() => nextPlay ? jump(nextPlay) : go(index + 1)} disabled={!nextPlay && index >= last} />
              <IconButton label="Next turn" icon={<ChevronLast size={18} />} onClick={() => go(turnJump(timeline, index, 1))} />
              <input className={styles.scrub} type="range" min={0} max={last} value={Math.min(index, last)}
                onChange={(event) => go(Number(event.target.value))} aria-label="Position in the replay"
                aria-valuetext={`Turn ${turn}, moment ${index + 1} of ${frames.length}`} />
              <span className={styles.where}>
                Turn {turn}{frame.view.activePlayerName ? ` · ${frame.view.activePlayerName}` : ''}
                {!loaded && total ? <span className={styles.loading}> · loading {Math.round((timeline.read / total) * 100)}%</span> : null}
              </span>
              <label className={styles.speed}>
                <span className="visually-hidden">Speed</span>
                <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
                  {SPEEDS.map((value) => <option key={value} value={value}>{value}×</option>)}
                </select>
              </label>
              {kept.has(turn) && (
                <Button size="sm" variant="print" icon={<GitBranch size={15} />} onClick={() => void takeOver(turn)} title={`Play on from the start of turn ${turn} against the computer`}>
                  Play from turn {turn}
                </Button>
              )}
              {!manifest && info?.truncated && <span className={styles.loading} title="The recording stopped early">partial</span>}
            </div>
          </div>
        </div>
        {panel && (mobilePanel ? <Dialog open onOpenChange={setAnalysis} title={t('replay.analysis')}>{panel}</Dialog>
          : <aside id={panelId} className={styles.analysis} aria-labelledby={`${panelId}-title`}>
            <h2 id={`${panelId}-title`}>{t('replay.analysis')}</h2>
            {panel}
          </aside>)}
      </div>
    </MatchErrorBoundary>
  );
}
