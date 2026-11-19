import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ChevronFirst, ChevronLast, GitBranch, Pause, Play, StepBack, StepForward } from 'lucide-react';
import { useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
import { ignoreMatchKey, matchKeysBlocked } from '../match/keyboard';
import { useMatchUi } from '../match/matchUi';
import { PRIVATE_PLAYTESTING } from '../playtesting';
import { playFromTurn, useSoloTurns } from '../solo/soloData';
import { useSession } from '../stores/session';
import { notify } from '../stores/toasts';
import { Button, IconButton } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { decisionFrame, replayName } from './decisionPresentation';
import { ReplayDecisionMarkers, RecordedDecision } from './ReplayDecision';
import { ReplayReviewPanel, ReviewSwitch } from './ReplayReviewPanel';
import { frameProjection, loadReviewAnnotations, loadReviewEvents, loadReviewManifest, loadReviewPlays, perspectivesFor, type ReviewMoment } from './reviewData';
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
  const [bothHands, setBothHands] = useState(true);
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
  const perspectives = useMemo(() => perspectivesFor(manifest), [manifest]);
  const viewerSeat = privacy?.viewerSeatId ?? manifest?.viewerSeatId;
  const perspective = perspectives.find((seat) => seat.seatId === requestedSeat)
    ?? perspectives.find((seat) => seat.seatId === viewerSeat)
    ?? perspectives.find((seat) => seat.owned);
  const archiveReady = manifest?.status === 'completed' && manifest.analysis?.status !== 'unavailable';
  const canShowBoth = manifest?.status === 'completed' && (privacy?.fullAvailable ?? manifest?.fullAvailable) === true;
  const showBoth = bothHands && canShowBoth;
  const otherSeat = !!perspective && perspective.seatId !== viewerSeat && (viewerSeat !== undefined || !perspective.owned);
  const scope = showBoth ? 'full' : archiveReady ? 'seat' : null;

  const eventQuery = useInfiniteQuery({
    queryKey: ['match-review', userName, gameId, 'plays', manifest?.archiveRevision],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => loadReviewPlays(gameId, pageParam, signal),
    getNextPageParam: (page) => page?.next ?? undefined,
    enabled: archiveReady,
    gcTime: 0,
  });
  const annotations = useInfiniteQuery({
    queryKey: ['match-review', userName, gameId, 'annotations', manifest?.archiveRevision, privacy?.fullAvailable ?? manifest?.fullAvailable],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => loadReviewAnnotations(gameId, pageParam, signal),
    getNextPageParam: (page) => page?.next ?? undefined,
    enabled: archiveReady,
    gcTime: 0,
  });
  const allAnnotations = useMemo(() => (annotations.data?.pages ?? []).flatMap((page) => page?.annotations ?? []), [annotations.data]);
  const events = useMemo(() => (eventQuery.data?.pages ?? []).flatMap((page) => page?.events ?? []), [eventQuery.data]);
  const plays = useMemo(() => events.flatMap((event): ReviewMoment[] => {
    const content = event.text ?? event.actual?.text ?? event.log?.message;
    return event.type === 'action' && event.frameCursor != null && content ? [{ ...event, text: content }] : [];
  }), [events]);
  const playsByCursor = useMemo(() => new Map(plays.map((play) => [play.cursor, play])), [plays]);
  const moments = useMemo(() => {
    const byCursor = new Map<number, ReviewMoment>(playsByCursor);
    for (const annotation of allAnnotations) {
      byCursor.set(annotation.cursor, {
        cursor: annotation.cursor, frameCursor: annotation.frameCursor, turn: annotation.evidence?.turn,
        actual: annotation.actual, text: annotation.actual.text, evidence: annotation.evidence, seatId: annotation.seatId,
        actor: perspectives.find((seat) => seat.seatId === annotation.seatId)?.name,
        decisionActor: annotation.decisionActor, decisionSeatId: annotation.decisionSeatId,
        ...byCursor.get(annotation.cursor), category: annotation.category,
      });
    }
    return [...byCursor.values()].sort((a, b) => a.cursor - b.cursor);
  }, [allAnnotations, perspectives, playsByCursor]);

  // Notes are lightweight. Load the remaining archive evidence as the viewer opens the decision list.
  const { fetchNextPage: fetchNextAnnotations, hasNextPage: hasMoreAnnotations, isFetching: fetchingAnnotations, isError: annotationsFailed } = annotations;
  const { fetchNextPage: fetchNextPlays, hasNextPage: hasMorePlays, isFetching: fetchingPlays, isError: playsFailed } = eventQuery;
  useEffect(() => {
    if (hasMoreAnnotations && !fetchingAnnotations && !annotationsFailed) void fetchNextAnnotations();
    if (analysisOpen && hasMorePlays && !fetchingPlays && !playsFailed) void fetchNextPlays();
  }, [analysisOpen, fetchNextAnnotations, hasMoreAnnotations, fetchingAnnotations, annotationsFailed, fetchNextPlays, hasMorePlays, fetchingPlays, playsFailed]);

  const selectedPlay = useQuery({
    queryKey: ['match-review', userName, gameId, 'play-at', action, manifest?.archiveRevision],
    queryFn: ({ signal }) => loadReviewPlays(gameId, action!, signal, 1),
    enabled: archiveReady && action !== undefined && !playsByCursor.has(action),
    gcTime: 0,
  });
  const selectedAnnotation = useQuery({
    queryKey: ['match-review', userName, gameId, 'annotations-at', action, manifest?.archiveRevision, canShowBoth],
    queryFn: ({ signal }) => loadReviewAnnotations(gameId, action!, signal),
    enabled: archiveReady && action !== undefined && !allAnnotations.some((item) => item.cursor === action),
    gcTime: 0,
  });
  const playAtCursor = action === undefined ? undefined : playsByCursor.get(action) ?? selectedPlay.data?.events.find((item) => item.cursor === action);
  const contextualAnnotations = allAnnotations.some((item) => item.cursor === action) ? allAnnotations : selectedAnnotation.data?.annotations;
  const selectedNote = contextualAnnotations?.find((item) => item.cursor === action && item.seatId === perspective?.seatId)
    ?? contextualAnnotations?.find((item) => item.cursor === action);
  const anchor = action === undefined ? undefined : decisionFrame({
    cursor: action, frameCursor: playAtCursor?.frameCursor ?? selectedNote?.frameCursor, actionFrameCursor: playAtCursor?.actionFrameCursor,
  });

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
      otherSeat ? perspective?.seatId : undefined),
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
    const position = Math.max(0, Math.min(last, next));
    setAction(undefined);
    setFrameIndex(position);
    setPlaying(false);
    setSearch((prior) => {
      const query = new URLSearchParams(prior);
      query.set('frame', String(position));
      query.delete('cursor');
      return query;
    }, { replace: true });
  }

  function togglePlayback() {
    if (playing) {
      go(index);
    } else {
      go(index >= last && loaded ? 0 : index);
      setPlaying(true);
    }
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

  const playbackMoment = action === undefined ? moments.find((moment) => moment.actionFrameCursor === frameCursor) : undefined;
  const currentCursor = action ?? playbackMoment?.cursor ?? frameCursor;
  const chosen = selectedNote ?? (playbackMoment && allAnnotations.find((item) => item.cursor === playbackMoment.cursor));
  const decision = playAtCursor || chosen || playbackMoment ? {
    cursor: currentCursor, text: chosen?.actual.text, actual: chosen?.actual, category: chosen?.category,
    evidence: chosen?.evidence, seatId: chosen?.seatId,
    decisionActor: chosen?.decisionActor, decisionSeatId: chosen?.decisionSeatId,
    actor: perspectives.find((seat) => seat.seatId === chosen?.seatId)?.name,
    ...playbackMoment, ...playAtCursor,
  } : undefined;
  const decisionKind = decision?.actual?.kind;
  const handDecision = decisionKind === 'mulligan' || decisionKind === 'keep';
  const decisionSeat = decision?.decisionSeatId ?? decision?.seatId;
  const contextAllowed = !!scope && (scope === 'full' || decision?.hasDecisionContext
    || !!decisionSeat && decisionSeat === perspective?.seatId);
  const contextCursor = decision?.cursor;
  const batchContext = privateFrameQuery.data?.events.find((item) => item.cursor === contextCursor
    && (item.decision || item.decisions?.length));
  const contextQuery = useQuery({
    queryKey: ['match-review', userName, gameId, 'decision-context', scope, perspective?.seatId, contextCursor, manifest?.archiveRevision],
    queryFn: ({ signal }) => loadReviewEvents(gameId, contextCursor!, scope!, 1, signal, otherSeat ? perspective?.seatId : undefined),
    enabled: analysisOpen && !playing && contextAllowed && contextCursor !== undefined
      && (decision?.hasDecisionContext || handDecision || decisionKind === 'select' || decisionKind === 'discard' || decisionKind === 'pass')
      && !batchContext,
    gcTime: 0,
    retry: false,
  });
  const contextEvent = contextAllowed ? batchContext ?? contextQuery.data?.events.find((item) => item.cursor === contextCursor) : undefined;
  const decisionContexts = contextEvent?.decisions?.length ? contextEvent.decisions : contextEvent?.decision ? [contextEvent.decision] : [];
  const missingDecisionHand = handDecision && contextAllowed && (contextQuery.isSuccess || !!batchContext)
    && !decisionContexts.some(({ cards }) => cards?.length);
  const previousMoment = moments.filter((item) => item.cursor < currentCursor).at(-1);
  const nextMoment = moments.find((item) => item.cursor > currentCursor);
  const canStepBack = !!previousMoment || index > 0;
  const canStepForward = !!nextMoment || index < last;

  function step(direction: -1 | 1) {
    const moment = direction === -1 ? previousMoment : nextMoment;
    if (moment) jump(moment);
    else if (direction === -1 ? canStepBack : canStepForward) go(index + direction);
  }

  const onReplayKey = useEffectEvent((event: KeyboardEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!frame || ignoreMatchKey(event) || event.altKey || event.ctrlKey || event.metaKey || matchKeysBlocked()) return;
    const widget = target?.closest('button, input, select, textarea, a, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="switch"], [role="slider"], [role="tab"], [role="combobox"], [role="listbox"], [role="radiogroup"]');
    if (event.key === ' ' && !widget && !event.shiftKey) {
      event.preventDefault();
      togglePlayback();
      return;
    }
    if ((widget && !widget.hasAttribute('data-replay-step-focus')) || (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')) return;
    event.preventDefault();
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    if (event.shiftKey) go(turnJump(timeline, index, direction));
    else step(direction);
  });
  useEffect(() => {
    window.addEventListener('keydown', onReplayKey);
    return () => window.removeEventListener('keydown', onReplayKey);
  }, []);

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
  const partialArchive = info?.truncated || manifest?.coverage?.partial === true || Object.values(manifest?.coverage ?? {}).some((entry) =>
    entry === 'partial' || entry === 'missing' || typeof entry === 'object' && entry.status === 'partial');
  const recordedHands = recorded?.hands;
  const completeHands = showBoth && !!recordedHands && (frame.view.players ?? []).every((player) =>
    player.playerId && Object.hasOwn(recordedHands, player.playerId));
  const shownHand = showBoth ? completeHands : recorded?.myHand ?? recorded?.view?.myHand;
  const previousFrameCursor = frames[Math.min(index, last) - 1]?.cursor ?? -1;
  const draws = privateFrameQuery.data?.events.filter((event) =>
    event.type === 'draw' && event.card?.name && event.cursor > previousFrameCursor && event.cursor <= frameCursor) ?? [];
  const viewStatus = (showBoth || otherSeat) && (privateFrameQuery.isError ? t('replay.privateFrameError')
    : privateFrameQuery.isPending ? t('replay.privateFrameLoading') : !shownHand ? t('replay.privateFrameMissing') : null);
  const reviewError = annotations.isError || eventQuery.isError || selectedPlay.isError || selectedAnnotation.isError;
  const setAnalysis = (open: boolean) => {
    setPlaying(false);
    setAnalysisOpen(open);
    if (!open && mobilePanel) requestAnimationFrame(() => toolbarRef.current?.querySelector<HTMLButtonElement>('[role="switch"]')?.focus());
  };
  const panel = manifest && analysisOpen && <ReplayReviewPanel analysis={manifest.analysis} moments={moments} current={decision?.cursor}
    sideboardDelta={manifest.status === 'completed' && manifest.gameNumber > 1 ? manifest.sideboardDelta : undefined}
    annotation={chosen} decision={decision} decisionContexts={decisionContexts} missingDecisionHand={missingDecisionHand}
    showRetrospective={showBoth && !!recorded} onMoment={jump} error={reviewError}
    onRetry={() => {
      void eventQuery.refetch();
      void annotations.refetch();
      if (selectedPlay.isError) void selectedPlay.refetch();
      if (selectedAnnotation.isError) void selectedAnnotation.refetch();
    }}
    onPrevious={previousMoment ? () => jump(previousMoment) : undefined} onNext={nextMoment ? () => jump(nextMoment) : undefined}
    loading={fetchingPlays || fetchingAnnotations || selectedAnnotation.isFetching} />;
  return (
    <MatchErrorBoundary gameId={gameId} backLabel="Back to History" onBack={leave}>
      <div className={styles.review} data-panel={manifest && analysisOpen && !mobilePanel ? 'open' : undefined} data-replay-cursor={currentCursor}>
        <div className={styles.table}>
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
                      {perspectives.map((seat) => <option key={seat.seatId} value={seat.seatId}>{replayName(seat.name, t)}</option>)}
                    </select>
                  </label>
                )}
              </div>
              {viewStatus && <p className={styles.coverage} role="status">{viewStatus}</p>}
              {partialArchive && <p className={styles.coverage}>{t('replay.partialArchive')}</p>}
              {manifest.status === 'active' && <p className={styles.coverage}>{t('replay.matchActive')}</p>}
              {decision && <RecordedDecision moment={decision} />}
            </div>
          )}
          <div className={styles.board}>
            <MatchStage session={session} state={state} replayHands={projection?.hands} reviewLayout={!!manifest} replayLog={replayLog} onLeave={leave} />
            {!!draws.length && (
              <ul className={styles.recordedDraws} aria-label={t('replay.draws')}>
                {draws.flatMap(({ actorPlayerId, card, cursor }) => {
                  const name = frame.view.players?.find((player) => player.playerId === actorPlayerId)?.name;
                  return name && card?.name ? [<li key={cursor}>{t('replay.drawn', { name: replayName(name, t), cards: card.name })}</li>] : [];
                })}
              </ul>
            )}
            {manifestQuery.isError && <div className={styles.reviewFailure} role="alert">
              {t('replay.reviewError')} <Button size="sm" variant="quiet" onClick={() => void manifestQuery.refetch()}>{t('replay.retry')}</Button>
            </div>}
          </div>
          <div className={styles.transport} role="toolbar" aria-label="Replay controls">
            <div className={styles.playback}>
              <IconButton label="Previous turn" icon={<ChevronFirst size={18} />} aria-keyshortcuts="Shift+ArrowLeft" data-replay-step-focus onClick={() => go(turnJump(timeline, index, -1))} />
              <IconButton label={manifest ? t('replay.previousPlay') : 'Step back'} icon={<StepBack size={18} />}
                aria-keyshortcuts="ArrowLeft" aria-disabled={!canStepBack} data-replay-step-focus onClick={() => step(-1)} />
              <IconButton label={playing ? 'Pause' : 'Play'} icon={playing ? <Pause size={18} /> : <Play size={18} />}
                pressed={playing} data-replay-step-focus onClick={togglePlayback} />
              <IconButton label={manifest ? t('replay.nextPlay') : 'Step forward'} icon={<StepForward size={18} />}
                aria-keyshortcuts="ArrowRight" aria-disabled={!canStepForward} data-replay-step-focus onClick={() => step(1)} />
              <IconButton label="Next turn" icon={<ChevronLast size={18} />} aria-keyshortcuts="Shift+ArrowRight" data-replay-step-focus onClick={() => go(turnJump(timeline, index, 1))} />
              <span className={styles.where}>
                Turn {turn}{frame.view.activePlayerName ? ` · ${replayName(frame.view.activePlayerName, t)}` : ''}
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
            <div className={styles.timeline}>
              <input className={styles.scrub} type="range" min={0} max={last} value={Math.min(index, last)}
                onChange={(event) => go(Number(event.target.value))} aria-label="Position in the replay"
                aria-valuetext={`Turn ${turn}, moment ${index + 1} of ${frames.length}`} />
              <ReplayDecisionMarkers moments={moments} timeline={timeline} current={decision?.cursor} onMoment={jump} />
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
