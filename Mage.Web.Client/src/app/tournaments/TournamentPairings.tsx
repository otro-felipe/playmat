import { useId, useState } from 'react';
import { Crown, ExternalLink, Eye, Play, RotateCcw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import { ArchetypeLabel, QualityMark } from '../ui/Archetype';
import { archetypeIdentity, archetypeStyle } from '../ui/archetypeIdentity';
import { Button, ButtonLink } from '../ui/Button';
import { Countdown } from './Countdown';
import { TournamentGameQualityReason } from './TournamentGameQualityReason';
import { EntryName } from './TournamentStandings';
import { entryArchetype, pairingQualityOwner, sharedOwner } from './tournamentEntries';
import { tournamentPath, type Entry, type Pairing, type TableGame, type Tournament } from './tournamentApi';
import styles from './TournamentScreen.module.css';
import board from './TournamentBoard.module.css';

const causes = ['concession', 'disconnect', 'inactivity', 'player_clock', 'round_clock'] as const;
const isCause = (cause: string): cause is (typeof causes)[number] => (causes as readonly string[]).includes(cause);

/** The replay of one game of a table: the table's replay opened on that game. */
const gameReplayUrl = (pair: Pairing, game: TableGame) => pair.replayUrl && pair.replayUrl + '?game=' + game.number;

function Side({ cup, entry, side, won, lost }: { cup: Tournament; entry: Entry; side: 'a' | 'b'; won: boolean; lost: boolean }) {
  const t = useT();
  const archetype = entryArchetype(cup, entry);
  return (
    <div className={board.side} data-side={side} data-won={won || undefined} data-lost={lost || undefined}>
      <ArchetypeLabel name={archetype.name} colors={archetype.colors} size="lg" align={side === 'a' ? 'start' : 'end'}
        title={<>
          {won && <Crown size={16} className={board.crown} aria-label={t('cup.tableWinner')} />}
          <EntryName entry={entry} showOwner={!sharedOwner(cup)} />
        </>} fallback={t('cup.archetypeHidden')} />
    </div>
  );
}

function GameRow({ pair, game, a, b, qualityOwner }: { pair: Pairing; game: TableGame; a?: Entry; b?: Entry; qualityOwner?: string }) {
  const t = useT();
  const winner = game.winner === 'a' ? a : game.winner === 'b' ? b : undefined;
  const replay = gameReplayUrl(pair, game);
  const playing = game.status === 'active' || game.status === 'playing';
  return (
    <li className={board.game} data-winner={game.winner ?? undefined}>
      <span className={board.gameNumber}>{t('cup.gameShort', { n: game.number })}</span>
      <span className={board.gameResult}>
        {playing ? <span className={board.livePill}>{t('cup.inPlay')}</span>
          : game.winner === 'draw' ? t('cup.gameDraw')
          : winner ? <><i className={board.dot} data-side={game.winner} aria-hidden="true" />{t('cup.gameWon', { name: winner.name })}</>
          : t('cup.gameUnknown')}
        {game.endCause && isCause(game.endCause) && <span className={board.cause}>{t(`cup.replayCause.${game.endCause}`)}</span>}
      </span>
      {!playing && (
        <QualityMark good={game.goodQuality} pending={game.status !== 'completed'}>
          {qualityOwner && game.status === 'completed'
            ? <TournamentGameQualityReason gameId={game.id} owner={qualityOwner} good={game.goodQuality} /> : undefined}
        </QualityMark>
      )}
      {replay ? (
        <Link to={replay} className={board.gameReplay} aria-label={t('cup.gameReplay', { n: game.number })}>
          <Play size={14} aria-hidden="true" />
          <span>{t('cup.replayShort')}</span>
        </Link>
      ) : <span />}
    </li>
  );
}

function PairingRow({ pair, entries, cup }: { pair: Pairing; entries: Map<string, Entry>; cup: Tournament }) {
  const t = useT();
  const labelId = useId();
  const stopped = pair.reason === 'cancelled';
  const a = entries.get(pair.a);
  const b = pair.b ? entries.get(pair.b) : undefined;
  const active = !stopped && !pair.completed;
  const live = active && pair.watchUrl;
  const play = active && pair.playUrl;
  const winner = pair.completed && !stopped ? (pair.winner === pair.a ? 'a' : pair.winner && pair.winner === pair.b ? 'b' : null) : null;
  const tiebreakWinner = !stopped && pair.completed && pair.winsA === pair.winsB && winner ? (winner === 'a' ? a : b) : null;
  const left = a ? archetypeIdentity(entryArchetype(cup, a).name, entryArchetype(cup, a).colors).colors : null;
  const right = b ? archetypeIdentity(entryArchetype(cup, b).name, entryArchetype(cup, b).colors).colors : null;
  const games = pair.games ?? [];
  const qualityOwner = pairingQualityOwner(cup.viewer, pair);
  const status = stopped ? t('cup.tableCancelled') : t(pair.tableId ? 'cup.active' : 'cup.pending');
  return (
    <li className={board.tableCard} aria-labelledby={labelId} style={archetypeStyle(left, pair.b ? right : undefined)}>
      <div className={board.matchup} data-bye={!pair.b || undefined}>
        <h4 id={labelId} className={board.tableNumber}>{t('cup.table', { n: pair.number })}</h4>
        {a && <Side cup={cup} entry={a} side="a" won={winner === 'a'} lost={winner === 'b'} />}
        <div className={board.score}>
          {pair.completed && !stopped ? (
            <strong aria-label={t('cup.scoreLabel', { a: pair.winsA, b: pair.winsB })}>{pair.winsA} – {pair.winsB}</strong>
          ) : pair.b ? (
            <span className={active && pair.tableId ? board.livePill : board.statusPill}>{status}</span>
          ) : null}
        </div>
        {b ? <Side cup={cup} entry={b} side="b" won={winner === 'b'} lost={winner === 'a'} />
          : <div className={board.side} data-side="b"><span className={board.bye}>{t('cup.bye')}</span></div>}
      </div>
      {(games.length > 0 || pair.replayUrl || live || play || tiebreakWinner || (active && pair.tableId && pair.deadlineAt)) && (
        <div className={board.detail}>
          {games.length > 0 ? (
            <ol className={board.games} aria-label={t('cup.tableGames', { n: pair.number })}>
              {games.map((game) => <GameRow key={game.id} pair={pair} game={game} a={a} b={b} qualityOwner={qualityOwner} />)}
            </ol>
          ) : pair.replayUrl && (
            <Link to={pair.replayUrl} className={board.fullReplay}>
              <RotateCcw size={15} aria-hidden="true" />
              {t('cup.replay')}
            </Link>
          )}
          {active && pair.tableId && pair.deadlineAt && pair.deadlineAt !== cup.deadlineAt && (
            <p className={board.note}>
              {t('cup.tableClock')} · <Countdown at={pair.deadlineAt} expired={t('cup.extraTurns')} />
            </p>
          )}
          {tiebreakWinner && <p className={board.note}>{t('cup.matchWinner', { name: tiebreakWinner.name })}</p>}
          {active && !!pair.absentWarningIds?.length && (
            <p className={styles.error}>
              {t('cup.absence', {
                names: pair.absentWarningIds.map((id) => entries.get(id)?.name).filter(Boolean).join(', '),
              })}
              {pair.attendanceDeadlineAt && <> · <Countdown at={pair.attendanceDeadlineAt} expired={t('cup.absent')} /></>}
            </p>
          )}
          {(live || play) && (
            <div className={board.tableActions}>
              {live && (
                <Link to={live} className={board.fullReplay}>
                  <Eye size={16} aria-hidden="true" />
                  {t('cup.live')}
                </Link>
              )}
              {play && (
                <ButtonLink size="sm" target="_blank" rel="noopener" href={tournamentPath(cup.id) + '/play'}
                  icon={<ExternalLink size={16} />}>
                  {t('cup.openSeat')}
                </ButtonLink>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function EliminationBracket({ cup, entries }: { cup: Tournament; entries: Map<string, Entry> }) {
  const t = useT();
  const rounds = [...new Set(cup.pairings.filter((p) => p.stage === 'playoffs').map((p) => p.roundNumber))].sort((a, b) => a - b);
  const [selected, setSelected] = useState<number | null>(null);
  const active = selected ?? rounds.at(-1);
  const stages = rounds.map((n) => {
    const pairs = cup.pairings.filter((p) => p.stage === 'playoffs' && p.roundNumber === n);
    const title = t(pairs.length === 1 ? 'cup.final' : pairs.length === 2 ? 'cup.semi' : 'cup.quarter');
    return { n, pairs, title };
  });
  if (!rounds.length) return null;
  return (
    <section className={board.rounds} aria-labelledby="cup-bracket">
      <h2 id="cup-bracket" className={board.sectionTitle}>{t('cup.bracket')}</h2>
      <div className={styles.stageButtons} aria-label={t('cup.bracket')}>
        {stages.map(({ n, title }) => (
          <Button size="sm" key={n} aria-pressed={n === active} onClick={() => setSelected(n)}>{title}</Button>
        ))}
      </div>
      {[...stages].reverse().map(({ n, pairs, title }) => (
        <section key={n} className={n === active ? styles.selectedStage : styles.stage}>
          <h3 className={board.roundTitle}>{title}</h3>
          <ul className={board.tableList}>
            {pairs.map((p) => <PairingRow cup={cup} key={p.id} pair={p} entries={entries} />)}
          </ul>
        </section>
      ))}
    </section>
  );
}

/** Every Swiss round, the latest first; inside a round the top tables (best standings) come first. */
export function Tables({ cup, entries }: { cup: Tournament; entries: Map<string, Entry> }) {
  const t = useT();
  const rounds = [...new Set(cup.pairings.filter((p) => p.stage !== 'playoffs').map((p) => p.roundNumber))].sort((a, b) => b - a);
  if (!rounds.length && cup.stage === 'playoffs') return null;
  return (
    <section className={board.rounds} aria-labelledby="cup-tables">
      <h2 id="cup-tables" className={board.sectionTitle}>{t('cup.tables')}</h2>
      {!rounds.length && <p className={styles.pending}>{t('cup.noTables')}</p>}
      {rounds.map((n) => {
        const pairs = cup.pairings.filter((p) => p.roundNumber === n && p.stage !== 'playoffs').sort((a, b) => a.number - b.number);
        const done = pairs.filter((p) => p.completed).length;
        const current = n === cup.roundNumber && !['finished', 'cancelled'].includes(cup.status);
        return (
          <section key={n} className={board.round} aria-labelledby={'cup-round-' + n}>
            <header className={board.roundHead}>
              <h3 id={'cup-round-' + n} className={board.roundTitle}>{t('cup.number', { n })}</h3>
              <span className={current ? board.livePill : board.statusPill}>
                {current ? t('cup.tablesDone', { count: done, total: pairs.length }) : t('cup.roundDone')}
              </span>
            </header>
            <ul className={board.tableList}>
              {pairs.map((p) => <PairingRow cup={cup} key={p.id} pair={p} entries={entries} />)}
            </ul>
          </section>
        );
      })}
    </section>
  );
}
