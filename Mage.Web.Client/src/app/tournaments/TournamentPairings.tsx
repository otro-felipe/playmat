import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import { Button, ButtonLink } from '../ui/Button';
import { Zone } from '../ui/Zone';
import { Countdown } from './Countdown';
import { Identity } from './TournamentStandings';
import { tournamentPath, type Entry, type Pairing, type Tournament } from './tournamentApi';
import styles from './TournamentScreen.module.css';

function PairingRow({ pair, entries, cup }: { pair: Pairing; entries: Map<string, Entry>; cup: Tournament }) {
  const t = useT();
  const tiebreakWinner = pair.completed && pair.winsA === pair.winsB && pair.winner ? entries.get(pair.winner) : null;
  const a = entries.get(pair.a),
    b = pair.b && entries.get(pair.b);
  return (
    <li className={styles.line}>
      <div>
        <small>{t('cup.table', { n: pair.number })}</small>
        {a && <Identity entry={a} />}
        {b ? <Identity entry={b} /> : <span>{t('cup.bye')}</span>}
      </div>
      <div>
        {pair.b && (
          <div className={styles.score}>
            {pair.completed ? pair.winsA + ' – ' + pair.winsB : t(pair.tableId ? 'cup.active' : 'cup.pending')}
          </div>
        )}
        {!pair.completed && pair.tableId && pair.deadlineAt && pair.deadlineAt !== cup.deadlineAt && (
          <p>{t('cup.tableClock')} · <Countdown at={pair.deadlineAt} expired={t('cup.extraTurns')} /></p>
        )}
        {tiebreakWinner && <p>{t('cup.matchWinner', { name: tiebreakWinner.name })}</p>}
        {!!pair.absentWarningIds?.length && (
          <p className={styles.error}>
            {t('cup.absence', {
              names: pair.absentWarningIds
                .map((id) => entries.get(id)?.name)
                .filter(Boolean)
                .join(', '),
            })}
            {pair.attendanceDeadlineAt && (
              <>
                {' '}
                · <Countdown at={pair.attendanceDeadlineAt} expired={t('cup.absent')} />
              </>
            )}
          </p>
        )}
        {pair.watchUrl && !pair.completed && (
          <Link to={pair.watchUrl} className={styles.link}>
            {t('cup.live')}
          </Link>
        )}
        {pair.replayUrl && (
          <Link to={pair.replayUrl} className={styles.link}>
            {t('cup.replay')}
          </Link>
        )}
        {pair.playUrl && !pair.completed && (
          <ButtonLink target="_blank" rel="noopener" href={tournamentPath(cup.id) + '/play'}>
            {t('cup.openSeat')}
          </ButtonLink>
        )}
      </div>
    </li>
  );
}
export function EliminationBracket({ cup, entries }: { cup: Tournament; entries: Map<string, Entry> }) {
  const t = useT();
  const rounds = [...new Set(cup.pairings.filter((p) => p.stage === 'playoffs').map((p) => p.roundNumber))].sort(
    (a, b) => a - b,
  );
  const [selected, setSelected] = useState<number | null>(null);
  const active = selected ?? rounds.at(-1);
  const stages = rounds.map((n) => {
    const pairs = cup.pairings.filter((p) => p.stage === 'playoffs' && p.roundNumber === n);
    const title = t(pairs.length === 1 ? 'cup.final' : pairs.length === 2 ? 'cup.semi' : 'cup.quarter');
    return { n, pairs, title };
  });
  if (!rounds.length) return null;
  return (
    <Zone label={t('cup.bracket')}>
      <div className={styles.stageButtons} aria-label={t('cup.bracket')}>
        {stages.map(({ n, title }) => (
          <Button size="sm" key={n} aria-pressed={n === active} onClick={() => setSelected(n)}>
            {title}
          </Button>
        ))}
      </div>
      <div className={styles.bracket}>
        {stages.map(({ n, pairs, title }) => (
          <section key={n} className={n === active ? styles.selectedStage : styles.stage}>
            <h3>{title}</h3>
            <ul className={styles.branch}>
              {pairs.map((p) => (
                <PairingRow cup={cup} key={p.id} pair={p} entries={entries} />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Zone>
  );
}
export function Tables({ cup, entries }: { cup: Tournament; entries: Map<string, Entry> }) {
  const t = useT();
  const rounds = [...new Set(cup.pairings.filter((p) => p.stage !== 'playoffs').map((p) => p.roundNumber))].sort(
    (a, b) => b - a,
  );
  if (!rounds.length && cup.stage === 'playoffs') return null;
  return (
    <Zone label={t('cup.tables')}>
      {!rounds.length && <p>{t('cup.noTables')}</p>}
      {rounds.map((n, index) => {
        const pairs = cup.pairings.filter((p) => p.roundNumber === n);
        const label = t('cup.number', { n }) + (pairs[0]?.stage === 'playoffs' ? ' · ' + t('cup.stagePlayoffs') : '');
        const list = (
          <ul className={styles.list}>
            {pairs.map((p) => (
              <PairingRow cup={cup} key={p.id} pair={p} entries={entries} />
            ))}
          </ul>
        );
        return !index ? (
          <section key={n}>
            <h3>{label}</h3>
            {list}
          </section>
        ) : (
          <details key={n}>
            <summary>{label}</summary>
            {list}
          </details>
        );
      })}
    </Zone>
  );
}
