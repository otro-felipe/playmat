import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Info, Pause, Play, StepBack, StepForward } from 'lucide-react';
import { useParams, useSearchParams } from 'react-router-dom';
import { registerMessages, useT } from '../i18n';
import messages from '../i18n/en/events';
import { SpectatorBroadcast, ProjectedBoard, type SpectatorSnapshot } from '../spectator/SpectatorScreen';
import { SpectatorFrame } from '../spectator/SpectatorFrame';
import { PublicBroadcast } from '../ui/usePlayerIdentity';
import { Button, ButtonLink, IconButton } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { request, tournamentApi, tournamentPath, useTournament } from './tournamentApi';
import styles from './TournamentScreen.module.css';
import replayStyles from './TournamentReplay.module.css';
import { TournamentFrameEvidence } from './TournamentFrameEvidence';
import type { PhaseStep } from '../../protocol/generated/views';

registerMessages(messages);
function pairingPath(id: string, pairing: string) {
  return tournamentApi + '/' + encodeURIComponent(id) + '/pairings/' + encodeURIComponent(pairing);
}
export function TournamentWatch() {
  const { id = '', pairingId = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const t = useT();
  const cup = useTournament(id);
  const admin = !!cup.data?.viewer?.isAdmin;
  const hands = admin && search.get('hands') === '1';
  const endpoint = pairingPath(id, pairingId) + '/watch' + (hands ? '?hands=1' : '');
  return (
    <SpectatorBroadcast
      key={endpoint}
      endpoint={endpoint}
      actions={
        <>
          {admin && (
            <Button size="sm" aria-pressed={hands} onClick={() => setSearch(hands ? {} : { hands: '1' })}>
              {t('watch.bothScope')}
            </Button>
          )}
          <ButtonLink href={tournamentPath(id)} size="sm">
            {t('cup.public')}
          </ButtonLink>
        </>
      }
    />
  );
}

type EndCause = 'concession' | 'disconnect' | 'inactivity' | 'player_clock' | 'round_clock';
type OfficialResult = { a: string; b: string; winsA: number; winsB: number; draws: number; winner: 'a' | 'b' | null; reason: string | null };
type Capture = {
  exportState: 'ready' | 'partial' | 'pending' | 'unavailable';
  terminalEvent: boolean;
  cause: EndCause | null;
  lastPublicEvent?: {kind:'board'|'recording_closed'|'game_end'|'rollback'|'game_log'|'public_line'; elapsedMs?: number} | null;
  outcome: 'a' | 'b' | 'draw' | null;
  lastBoard: { frame: number; status: string; turn?: number; step?: PhaseStep } | null;
};
type ReplayIndex = { officialResult: OfficialResult | null; games: { gameId: string; gameNumber: number; frameCount: number; capture: Capture }[] };
const playbackSpeeds = [0.5, 1, 2, 4];
const frameDelayMs = 1100;

function ReplayEnding({ official, capture }: { official?: OfficialResult | null; capture?: Capture }) {
  const t = useT();
  if (!official && !capture) return null;
  const last = capture?.lastBoard;
  return <div className={styles.replayEnding}>
    {official && <div>
      <strong>{t('cup.replayOfficial')}</strong>{' '}
      {t('cup.replayScore', { a: official.a, b: official.b, wa: official.winsA, wb: official.winsB })}
      {official.draws > 0 && <> · {t('cup.replayDraws', { n: official.draws })}</>}
      {official.reason === 'played' && !official.winner && official.winsA === official.winsB && <> · {t('cup.replayMatchDraw')}</>}
      {official.reason === 'afk' && <> · {t('cup.replayAfk')}</>}
      {official.winner && <> · {t('cup.replayWinner', { name: official[official.winner] })}</>}
    </div>}
    {capture && <div>
      <strong>{t('cup.replayRecording')}</strong>{' '}
      {t(`cup.replayExport.${capture.exportState}`)}
      {last && <> · {t('cup.replayLastBoard')}{last.turn != null && <> · {t('cup.replayTurn', { n: last.turn })}</>}{last.step && <> · {t(`cup.replayStep.${last.step}`)}</>}
        {last.status === 'playing' && <> · {t('cup.replayInPlay')}</>}</>}
      {capture.lastPublicEvent && capture.lastPublicEvent.kind !== 'board' && capture.lastPublicEvent.kind !== 'game_end' &&
        <> · {t(`cup.replayEvent.${capture.lastPublicEvent.kind}`)}</>}
      {(capture.exportState === 'ready' || capture.exportState === 'partial') && <> · {t(capture.terminalEvent ? 'cup.replayTerminal' : 'cup.replayNoTerminal')}</>}
      {capture.outcome === 'draw' && <> · {t('cup.replayGameDraw')}</>}
      {official && (capture.outcome === 'a' || capture.outcome === 'b') && <> · {t('cup.replayGameWinner', { name: official[capture.outcome] })}</>}
      {capture.cause && <> · {t(`cup.replayCause.${capture.cause}`)}</>}
    </div>}
  </div>;
}
export function TournamentReplay() {
  const { id = '', pairingId = '' } = useParams();
  const endpoint = pairingPath(id, pairingId) + '/replay';
  return <Replay key={endpoint} endpoint={endpoint} back={tournamentPath(id)} />;
}
function Replay({ endpoint, back }: { endpoint: string; back: string }) {
  const t = useT();
  const [selectedGame, setGame] = useState<string>();
  const [requestedFrame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [infoOpen, setInfoOpen] = useState(false);
  const infoButton = useRef<HTMLButtonElement>(null);
  const index = useQuery({
    queryKey: [endpoint],
    queryFn: ({ signal }) => request<ReplayIndex>(endpoint, undefined, signal),
    retry: false,
  });
  const games = index.data?.games ?? [];
  const game = games.find(({ gameId }) => gameId === selectedGame) ?? games[0];
  const count = game?.frameCount ?? 0;
  const last = Math.max(0, count - 1);
  const frameIndex = Math.min(requestedFrame, last);
  const frame = useQuery<SpectatorSnapshot>({
    queryKey: [endpoint, game?.gameId, frameIndex],
    enabled: !!game?.frameCount,
    placeholderData: previous => previous?.gameId === game?.gameId ? previous : undefined,
    queryFn: ({ signal }) =>
      request<SpectatorSnapshot>(
        endpoint + '?gameId=' + encodeURIComponent(game!.gameId) + '&frame=' + frameIndex,
        undefined,
        signal,
      ),
    retry: false,
    gcTime: 5000,
  });
  useEffect(() => {
    if (!playing || !frame.data?.view || frame.isPlaceholderData || frameIndex >= last) return;
    const timer = window.setTimeout(() => {
      const next = frameIndex + 1;
      setFrame(next);
      if (next === last) setPlaying(false);
    }, frameDelayMs / speed);
    return () => window.clearTimeout(timer);
  }, [frame.data, frame.isPlaceholderData, frameIndex, last, playing, speed]);
  const current = frame.data;
  const official = index.data?.officialResult;
  const position = count ? frameIndex + 1 : 0;
  const canPlay = count > 1;
  const isPlaying = playing && frameIndex < last;
  const canShowInfo = Boolean(official || game?.capture || current?.facts?.length);
  const title = t('cup.replayTitle');
  function seekTo(next: number) {
    setPlaying(false);
    setFrame(next);
  }
  function togglePlayback() {
    if (frameIndex === last) {
      setFrame(0);
      setPlaying(true);
    } else {
      setPlaying(!isPlaying);
    }
  }
  return (
    <PublicBroadcast.Provider value>
      <SpectatorFrame
        customHeader={{ label: title, content: <div className={replayStyles.controls}>
          <div className={replayStyles.context}>
            <ButtonLink href={back} size="sm" variant="quiet" className={replayStyles.back}
              aria-label={t('cup.replayBack')} title={t('cup.replayBack')} icon={<ArrowLeft size={18} />}>
              <span className={replayStyles.backLabel}>{t('cup.replayTournament')}</span>
            </ButtonLink>
            {official ? (
              <h1 className={replayStyles.pairing} aria-label={t('cup.replayScore', {
                a: official.a, b: official.b, wa: official.winsA, wb: official.winsB,
              })}>
                <span title={official.a}>{official.a}</span><strong>{official.winsA}–{official.winsB}</strong>
                <span title={official.b}>{official.b}</span>
              </h1>
            ) : <h1 className={replayStyles.replayTitle}>{title}</h1>}
            <select className={replayStyles.select} aria-label={t('cup.replayGame')} value={game?.gameId ?? ''}
              disabled={!game} onChange={event => { setGame(event.target.value); seekTo(0); }}>
              {!game && <option value="">{t('cup.replayGame')}</option>}
              {games.map((item, i) => <option key={item.gameId} value={item.gameId}>{t('cup.game', { n: item.gameNumber ?? i + 1 })}</option>)}
            </select>
            <IconButton ref={infoButton} label={t('cup.replayInfo')} icon={<Info size={18} />} className={replayStyles.icon}
              aria-haspopup="dialog" disabled={!canShowInfo} onClick={() => { setPlaying(false); setInfoOpen(true); }} />
          </div>
          <div className={replayStyles.playback}>
            <div className={replayStyles.transport}>
              <IconButton label={t('cup.replayPrevious')} icon={<StepBack size={18} />} className={replayStyles.icon}
                disabled={frameIndex <= 0} onClick={() => seekTo(frameIndex - 1)} />
              <IconButton label={t(isPlaying ? 'cup.stopReplay' : 'cup.playReplay')} icon={isPlaying ? <Pause size={18} /> : <Play size={18} />}
                className={`${replayStyles.icon} ${replayStyles.play}`} disabled={!canPlay} onClick={togglePlayback} />
              <IconButton label={t('cup.replayNext')} icon={<StepForward size={18} />} className={replayStyles.icon}
                disabled={frameIndex >= last} onClick={() => seekTo(frameIndex + 1)} />
            </div>
            <label className={replayStyles.seek}>
              <input type="range" aria-label={t('cup.replayPosition')} aria-valuetext={t('cup.replayPositionValue', { position, count })}
                min={0} max={last} value={frameIndex} disabled={!canPlay} onChange={event => seekTo(Number(event.target.value))} />
              <span aria-hidden="true" className={replayStyles.counter}>{position} / {count}</span>
            </label>
            <select className={`${replayStyles.select} ${replayStyles.speed}`} aria-label={t('cup.replaySpeed')} value={speed}
              disabled={!canPlay} onChange={event => setSpeed(Number(event.target.value))}>
              {playbackSpeeds.map(rate => <option key={rate} value={rate}>{t('cup.replayRate', { rate })}</option>)}
            </select>
          </div>
        </div> }}
      >
        {current?.view && current.gameId ? (
          <ProjectedBoard frame={current} gameId={current.gameId} />
        ) : (
          <p role="status" className={styles.inner}>
            {t(index.isPending || (game && frame.isFetching) ? 'cup.loading' : 'cup.noFrames')}
          </p>
        )}
      </SpectatorFrame>
      <Dialog open={infoOpen} onOpenChange={setInfoOpen} title={t('cup.replayClosing')} returnFocusRef={infoButton}>
        <ReplayEnding official={official} capture={game?.capture} />
        {current?.view && <TournamentFrameEvidence facts={current.facts} />}
      </Dialog>
    </PublicBroadcast.Provider>
  );
}
