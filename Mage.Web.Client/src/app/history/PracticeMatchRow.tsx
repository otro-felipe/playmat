import { displayArchetype } from '../decks/displayArchetype';
import { ArrowDownRight, ArrowUpRight, ChevronRight, Clapperboard, Minus } from 'lucide-react';
import { Fragment, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDate, useT } from '../i18n';
import { RatingCounts } from '../replay/ReplayReviewPanel';
import { NameLevel } from '../social/LevelBadge';
import { Button } from '../ui/Button';
import { PlayerLabel } from '../ui/PlayerLabel';
import { findSeat, matchPerspective, type PracticeGame, type PracticeMatch } from './practiceHistory';
import styles from './PracticeHistory.module.css';

interface RowProps {
  match: PracticeMatch;
  account: string;
  selected: string[];
  onSelect: (id: string) => void;
}

export function PracticeMatchRow({ match, account, selected, onSelect }: RowProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const { viewer, rivals, result, score } = matchPerspective(match, account);
  const shortDate = match.startedAt ? formatDate(match.startedAt, { day: 'numeric', month: 'short' }) : '—';
  const fullDate = match.startedAt ? formatDate(match.startedAt, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const Icon = result === 'win' ? ArrowUpRight : result === 'loss' ? ArrowDownRight : Minus;
  return <li className={styles.match}>
    <button className={styles.toggle} type="button" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen(!open)}>
      <span className={styles.date} title={fullDate}><span className={styles.fullDate}>{fullDate}</span><span className={styles.shortDate}>{shortDate}</span></span>
      <span className={styles.rival}>
        {rivals.length ? rivals.map((rival, index) => <Fragment key={rival.name}>
          {index > 0 && ', '}<PlayerLabel {...rival} />
        </Fragment>) : match.name}
        {rivals.some(rival => rival.archetype) && <small>{rivals.filter(rival => rival.archetype).map(rival => displayArchetype(t, rival.archetype)).join(', ')}</small>}
        <small className={styles.mobileArchetype}>{t('history.yourArchetype')} · {displayArchetype(t, viewer?.archetype)}</small>
      </span>
      <span className={styles.archetype}>{displayArchetype(t, viewer?.archetype)}</span>
      <span className={styles.format}>{match.format === 'Unknown' ? t('history.unreported') : match.format}</span>
      <span className={styles.outcome} data-outcome={result}><Icon size={15} aria-hidden="true" />{t(`history.${result}`)}</span>
      <strong className={styles.score}>{score}</strong>
      <ChevronRight size={16} className={styles.chevron} aria-hidden="true" />
    </button>
    <div hidden={!open} id={detailId} className={styles.details}>
      {open && <>
        <div className={styles.detailMeta}><span>{fullDate}</span><span>{match.format === 'Unknown' ? t('history.unreported') : match.format}</span></div>
        {match.games.map((game) => <GameDetail key={game.gameId} game={game} selected={selected} onSelect={onSelect} />)}
        {match.status === 'completed' && match.analysis && <HistoryAnalysis match={match} />}
      </>}
    </div>
  </li>;
}

function GameDetail({ game, selected, onSelect }: Pick<RowProps, 'selected' | 'onSelect'> & { game: PracticeGame }) {
  const t = useT();
  const navigate = useNavigate();
  const label = t('history.game', { number: game.gameNumber });
  const starter = game.startPlayer ? findSeat(game, game.startPlayer) ?? { name: game.startPlayer } : null;
  const chosen = selected.includes(game.gameId);
  const agentSeats = game.players?.filter((player) => player.isMcp) ?? [];
  return <section className={styles.game} aria-label={label}>
    <div className={styles.gameHead}>
      <h3>{label}</h3>
      {game.replayAvailable && <div className={styles.gameActions}>
        <label><input type="checkbox" checked={chosen} disabled={!chosen && selected.length >= 10}
          aria-label={t('history.selectGame', { number: game.gameNumber })} onChange={() => onSelect(game.gameId)} />{t('history.select')}</label>
        <Button size="sm" variant="quiet" icon={<Clapperboard size={15} />} onClick={() => navigate(`/replay/${game.gameId}`)}>{t('history.replay')}</Button>
      </div>}
    </div>
    <div className={styles.seats}>
      {(game.players ?? []).map((seat, index) => <Fragment key={seat.name}>
        {index > 0 && <span className={styles.versus}>vs</span>}
        <span><PlayerLabel {...seat} /><NameLevel name={seat.name} /></span>
      </Fragment>)}
    </div>
    <dl className={styles.smallStats}>
      <div><dt>{t('history.turns')}</dt><dd>{game.turns ?? '—'}</dd></div>
      <div><dt>{t('history.mulligans')}</dt><dd>{game.ownMulligans ?? '—'}</dd></div>
      {starter && <div><dt>{t('history.starts')}</dt><dd><PlayerLabel {...starter} /></dd></div>}
      {agentSeats.map((seat) => <Fragment key={seat.name}>
        <div><dt>{t('history.model')}{agentSeats.length > 1 && <> · <PlayerLabel {...seat} /></>}</dt><dd>{seat.model ?? t('history.unreported')}</dd></div>
        <div><dt>{t('history.reasoning')}</dt><dd>{seat.reasoningEffort ?? t('history.unreported')}</dd></div>
      </Fragment>)}
    </dl>
    {game.archiveState === 'partial' && <p>{t('history.partial')}</p>}
    {!!game.endedAt && game.archiveState === 'pending' && <p>{t('history.archiving')}</p>}
  </section>;
}

function HistoryAnalysis({ match }: { match: PracticeMatch }) {
  const t = useT();
  const navigate = useNavigate();
  const review = match.analysis!;
  const gamesWithReviews = match.games.filter((game) => game.replayAvailable && game.analysis?.reviewed);
  return <div className={styles.analysis}>
    <strong>{t(`replay.status.${review.status}`)}</strong>
    {review.reviewed > 0 && <>
      <p>{review.eligible === null ? t('replay.reviewedCount', { count: review.reviewed }) : t('replay.reviewed', { reviewed: review.reviewed, eligible: review.eligible })}</p>
      <RatingCounts counts={review.counts} />
    </>}
    {gamesWithReviews.length > 0 && <details>
      <summary>{t('replay.historyBreakdown')}</summary>
      {gamesWithReviews.map((game) => {
        const label = t('history.game', { number: game.gameNumber });
        return <section key={game.gameId} role="group" aria-label={label} className={styles.breakdown}>
          <Button variant="quiet" size="sm" onClick={() => navigate(`/replay/${game.gameId}?analysis=1`)}>{t('replay.analysis')} · {label}</Button>
          {game.analysis?.bySeat?.filter((seat) => !!seat.reviewed || Object.values(seat.counts).some(Boolean)).map((seat) => {
            const player = game.players?.find((player) => player.seatId === seat.seatId) ?? findSeat(game, seat.name ?? seat.seatId);
            return <div key={seat.seatId}>
              <strong><PlayerLabel {...(player ?? { name: seat.name ?? t('replay.perspective') })} /></strong>
              <RatingCounts counts={seat.counts} />
            </div>;
          })}
        </section>;
      })}
    </details>}
  </div>;
}
