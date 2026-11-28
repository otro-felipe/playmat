import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CircleCheck, CircleDashed, Crown, Info, Layers, Pause, Play, Star, StepBack, StepForward } from 'lucide-react';
import { useParams, useSearchParams } from 'react-router-dom';
import { registerMessages, useT } from '../i18n';
import messages from '../i18n/en/events';
import { SpectatorBroadcast, ProjectedBoard, type SpectatorSnapshot } from '../spectator/SpectatorScreen';
import { SpectatorFrame } from '../spectator/SpectatorFrame';
import { PublicBroadcast } from '../ui/usePlayerIdentity';
import { Button, ButtonLink, IconButton } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { request, tournamentApi, tournamentPath, useTournament, type Entry, type Tournament } from './tournamentApi';
import { entryArchetype } from './tournamentEntries';
import { ArchetypeLabel, ArchetypeMark } from '../ui/Archetype';
import { archetypeIdentity, archetypeStyle } from '../ui/archetypeIdentity';
import { DeckListView } from '../ui/DeckListView';
import { SeatAccents } from '../match/seatAccents';
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
type ReplayGame = { gameId: string; gameNumber: number; frameCount: number; capture: Capture; goodQuality?: boolean; qualityReason?: string };
type ReplayIndex = { officialResult: OfficialResult | null; games: ReplayGame[] };
const playbackSpeeds = [0.5, 1, 2, 4];
const frameDelayMs = 1100;

const markOf = (cup: Tournament, entry: Entry) => {
  const { name, colors } = entryArchetype(cup, entry);
  return { name, colors };
};

/** The two seats of the table as tournament entries, matched by their published names. */
function seatsOf(cup: Tournament | undefined, official: OfficialResult | null | undefined) {
  const find = (name?: string) => cup?.participants?.find((e) => e.name === name);
  return { a: find(official?.a), b: find(official?.b) };
}

function SeatHeader({ cup, entry, name, side, won }: { cup?: Tournament; entry?: Entry; name: string; side: 'a' | 'b'; won: boolean }) {
  const t = useT();
  const archetype = cup && entry ? entryArchetype(cup, entry) : { name: null, colors: null };
  return (
    <div className={replayStyles.seat} data-side={side} data-won={won || undefined}>
      <ArchetypeLabel name={archetype.name} colors={archetype.colors} size="lg" align={side === 'a' ? 'start' : 'end'}
        title={<>{won && <Crown size={15} aria-label={t('cup.tableWinner')} className={replayStyles.crown} />}{name}</>} />
    </div>
  );
}

/** The table's result, each game's outcome and the judge's verdict, and the recording's state in one line. */
function ReplayInfo({ official, games, current, cup, choose }: {
  official?: OfficialResult | null;
  games: ReplayGame[];
  current?: ReplayGame;
  cup?: Tournament;
  choose(gameId: string): void;
}) {
  const t = useT();
  const seats = seatsOf(cup, official);
  const colors = (entry?: Entry) => (cup && entry ? archetypeIdentity(entryArchetype(cup, entry).name, entryArchetype(cup, entry).colors).colors : null);
  return (
    <div className={replayStyles.info} style={archetypeStyle(colors(seats.a), colors(seats.b))}>
      {official && (
        <section className={replayStyles.result} aria-label={t('cup.replayOfficial')}>
          <SeatHeader cup={cup} entry={seats.a} name={official.a} side="a" won={official.winner === 'a'} />
          <div className={replayStyles.bigScore}>
            <strong>{official.winsA} – {official.winsB}</strong>
            <small>
              {official.reason === 'afk' ? t('cup.replayAfk')
                : official.winner ? t('cup.replayWinner', { name: official[official.winner] })
                  : official.reason === 'played' && official.winsA === official.winsB ? t('cup.replayMatchDraw') : t('cup.replayOfficial')}
              {official.draws > 0 && <> · {t('cup.replayDraws', { n: official.draws })}</>}
            </small>
          </div>
          <SeatHeader cup={cup} entry={seats.b} name={official.b} side="b" won={official.winner === 'b'} />
        </section>
      )}
      <ol className={replayStyles.gameList} aria-label={t('cup.replayGames')}>
        {games.map((game) => {
          const { capture } = game;
          const last = capture.lastBoard;
          const winner = capture.outcome === 'a' || capture.outcome === 'b' ? official?.[capture.outcome] : null;
          const recorded = capture.exportState === 'ready' && capture.terminalEvent;
          return (
            <li key={game.gameId} data-current={game.gameId === current?.gameId || undefined}>
              <div className={replayStyles.gameLine}>
                <button type="button" className={replayStyles.gamePick} onClick={() => choose(game.gameId)}
                  aria-current={game.gameId === current?.gameId ? 'true' : undefined}>
                  {t('cup.game', { n: game.gameNumber })}
                </button>
                <span className={replayStyles.gameOutcome}>
                  {winner ? <><i className={replayStyles.dot} data-side={capture.outcome!} aria-hidden="true" />{t('cup.gameWon', { name: winner })}</>
                    : capture.outcome === 'draw' ? t('cup.replayGameDraw') : t('cup.gameUnknown')}
                  {last?.turn != null && <span className={replayStyles.fact}>{t('cup.replayTurn', { n: last.turn })}</span>}
                  {capture.cause && <span className={replayStyles.fact}>{t(`cup.replayCause.${capture.cause}`)}</span>}
                </span>
                <details className={replayStyles.recording}>
                  <summary>
                    {recorded ? <CircleCheck size={16} aria-hidden="true" /> : <CircleDashed size={16} aria-hidden="true" />}
                    <span>{t(recorded ? 'cup.replayRecorded' : 'cup.replayPartial')}</span>
                  </summary>
                  <p>
                    {t(`cup.replayExport.${capture.exportState}`)}
                    {(capture.exportState === 'ready' || capture.exportState === 'partial') &&
                      <> · {t(capture.terminalEvent ? 'cup.replayTerminal' : 'cup.replayNoTerminal')}</>}
                    {last && <> · {t('cup.replayLastBoard')}{last.step && <> · {t(`cup.replayStep.${last.step}`)}</>}
                      {last.status === 'playing' && <> · {t('cup.replayInPlay')}</>}</>}
                    {capture.lastPublicEvent && capture.lastPublicEvent.kind !== 'board' && capture.lastPublicEvent.kind !== 'game_end' &&
                      <> · {t(`cup.replayEvent.${capture.lastPublicEvent.kind}`)}</>}
                  </p>
                </details>
              </div>
              {game.goodQuality !== undefined && (
                <div className={replayStyles.verdict} data-good={game.goodQuality || undefined}>
                  <strong><Star size={14} aria-hidden="true" fill={game.goodQuality ? 'currentColor' : 'none'} />
                    {t(game.goodQuality ? 'quality.good' : 'quality.poor')}</strong>
                  {game.qualityReason ? <p>{game.qualityReason}</p> : !game.goodQuality && <p>{t('quality.poorHint')}</p>}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Both players' lists, one at a time. */
function ReplayDecks({ cup, official }: { cup?: Tournament; official?: OfficialResult | null }) {
  const t = useT();
  const seats = seatsOf(cup, official);
  const decks = (['a', 'b'] as const).flatMap((side) => {
    const entry = seats[side];
    const deck = entry && cup?.deckLists?.find((d) => d.entryId === entry.id);
    return deck && entry ? [{ side, entry, deck }] : [];
  });
  const [shown, setShown] = useState<'a' | 'b'>('a');
  if (!decks.length || !cup) return <p className={replayStyles.empty}>{t('cup.decklistsPending')}</p>;
  const current = decks.find((d) => d.side === shown) ?? decks[0];
  return (
    <div className={replayStyles.decks}>
      <div className={replayStyles.deckTabs} role="tablist" aria-label={t('cup.decks')}>
        {decks.map(({ side, entry, deck }) => (
          <button key={side} type="button" role="tab" aria-selected={side === current.side} className={replayStyles.deckTab}
            onClick={() => setShown(side)}>
            <ArchetypeLabel name={deck.archetype} colors={entry.colors} title={entry.name} />
          </button>
        ))}
      </div>
      <div role="tabpanel">
        <DeckListView main={current.deck.cards.map((c) => ({ name: c.cardName, amount: c.amount }))}
          sideboard={current.deck.sideboard.map((c) => ({ name: c.cardName, amount: c.amount }))} />
      </div>
    </div>
  );
}

export function TournamentReplay() {
  const { id = '', pairingId = '' } = useParams();
  const cup = useTournament(id);
  const endpoint = pairingPath(id, pairingId) + '/replay';
  return <Replay key={endpoint} endpoint={endpoint} back={tournamentPath(id)} cup={cup.data} />;
}
function Replay({ endpoint, back, cup }: { endpoint: string; back: string; cup?: Tournament }) {
  const t = useT();
  const [search] = useSearchParams();
  const [selectedGame, setGame] = useState<string>();
  const [decksOpen, setDecksOpen] = useState(false);
  const decksButton = useRef<HTMLButtonElement>(null);
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
  // A table's game rows link here with ?game=N; the viewer's own choice wins once made.
  const game = games.find(({ gameId }) => gameId === selectedGame)
    ?? games.find(({ gameNumber }) => String(gameNumber) === search.get('game')) ?? games[0];
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
  const seats = seatsOf(cup, official);
  const accents = cup && official ? Object.fromEntries((['a', 'b'] as const).flatMap((side) => {
    const entry = seats[side];
    if (!entry) return [];
    const archetype = entryArchetype(cup, entry);
    return [[official[side], archetypeIdentity(archetype.name, archetype.colors).colors]];
  })) : null;
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
                <span title={official.a}>{seats.a && cup && <ArchetypeMark size="sm" {...markOf(cup, seats.a)} />}{official.a}</span>
                <strong>{official.winsA}–{official.winsB}</strong>
                <span title={official.b}>{seats.b && cup && <ArchetypeMark size="sm" {...markOf(cup, seats.b)} />}{official.b}</span>
              </h1>
            ) : <h1 className={replayStyles.replayTitle}>{title}</h1>}
            <select className={replayStyles.select} aria-label={t('cup.replayGame')} value={game?.gameId ?? ''}
              disabled={!game} onChange={event => { setGame(event.target.value); seekTo(0); }}>
              {!game && <option value="">{t('cup.replayGame')}</option>}
              {games.map((item, i) => <option key={item.gameId} value={item.gameId}>{t('cup.game', { n: item.gameNumber ?? i + 1 })}</option>)}
            </select>
            <IconButton ref={decksButton} label={t('cup.replayDecks')} icon={<Layers size={18} />} className={replayStyles.icon}
              aria-haspopup="dialog" disabled={!cup?.deckLists?.length} onClick={() => { setPlaying(false); setDecksOpen(true); }} />
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
          <SeatAccents.Provider value={accents}>
            <ProjectedBoard frame={current} gameId={current.gameId} />
          </SeatAccents.Provider>
        ) : (
          <p role="status" className={styles.inner}>
            {t(index.isPending || (game && frame.isFetching) ? 'cup.loading' : 'cup.noFrames')}
          </p>
        )}
      </SpectatorFrame>
      <Dialog open={infoOpen} onOpenChange={setInfoOpen} title={t('cup.replayClosing')} returnFocusRef={infoButton} width="lg">
        <ReplayInfo official={official} games={games} current={game} cup={cup} choose={(gameId) => { setGame(gameId); seekTo(0); setInfoOpen(false); }} />
        {current?.view && <TournamentFrameEvidence facts={current.facts} />}
      </Dialog>
      <Dialog open={decksOpen} onOpenChange={setDecksOpen} title={t('cup.replayDecks')} returnFocusRef={decksButton} width="xl">
        <ReplayDecks cup={cup} official={official} />
      </Dialog>
    </PublicBroadcast.Provider>
  );
}
