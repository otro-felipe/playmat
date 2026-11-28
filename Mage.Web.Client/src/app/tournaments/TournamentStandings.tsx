import { Link } from 'react-router-dom';
import { useI18n, useT } from '../i18n';
import { AgentModelLabel } from '../ui/AgentModelLabel';
import { ArchetypeLabel } from '../ui/Archetype';
import { Zone } from '../ui/Zone';
import type { Entry, Tournament } from './tournamentApi';
import { entryArchetype, sharedOwner } from './tournamentEntries';
import styles from './TournamentScreen.module.css';
import board from './TournamentBoard.module.css';

/** A participant's name, its agent model, and its owner when the tournament has several. */
export function EntryName({ entry, showOwner = true }: { entry: Entry; showOwner?: boolean }) {
  const t = useT();
  return (
    <span className={board.entryName}>
      <span className={board.entryTitle}>{entry.name}</span>
      {entry.kind === 'agent' && <AgentModelLabel {...entry} />}
      {showOwner && (
        <span className={board.owner}>
          {entry.kind === 'agent' && t('cup.agentOf') + ' '}
          <Link to={'/tournaments/owners/' + encodeURIComponent(entry.owner)}>{entry.owner}</Link>
        </span>
      )}
    </span>
  );
}

/** Kept for callers outside the board: a participant's name with its owner. */
export function Identity({ entry }: { entry: Entry }) {
  return <EntryName entry={entry} />;
}

export function Roster({ cup }: { cup: Tournament }) {
  const t = useT();
  const states = {
    qualified: 'cup.qualified',
    eliminated: 'cup.eliminated',
    disqualified: 'cup.disqualified',
    absent: 'cup.absent',
  } as const;
  const owner = sharedOwner(cup);
  return (
    <Zone label={t('cup.roster')} aside={<span className={styles.muted}>
      {t('cup.ready', { count: cup.participants.filter((e) => e.online).length, total: cup.participants.length })}</span>}>
      <ul className={styles.list}>
        {cup.participants.map((entry) => (
          <li key={entry.id} className={styles.line}>
            <span className={board.withPresence}>
              <i className={board.presence} data-online={entry.online || undefined} aria-hidden="true" />
              <EntryName entry={entry} showOwner={!owner} />
            </span>
            {Object.hasOwn(states, entry.state) && <span>{t(states[entry.state as keyof typeof states])}</span>}
            <span className={entry.online ? styles.positive : styles.muted}>
              {t(entry.online ? 'cup.online' : 'cup.offline')}
            </span>
          </li>
        ))}
      </ul>
    </Zone>
  );
}

/**
 * The standings as one table: who played what, the record and points that decide the ranking, then the
 * win rates and tiebreakers that order equal points.
 */
export function Standings({ cup }: { cup: Tournament }) {
  const t = useT();
  const locale = useI18n((s) => s.locale);
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 });
  const live = !['finished', 'cancelled'].includes(cup.status);
  const owner = sharedOwner(cup);
  const rate = (value: number) => (Number.isFinite(value) ? percent.format(value) : '—');
  return (
    <section className={board.standings} aria-labelledby="cup-standings">
      <h2 id="cup-standings" className={board.sectionTitle}>{t('cup.standings')}</h2>
      <div className={board.scroll}>
        <table className={board.table}>
          <thead>
            <tr>
              <th scope="col" className={board.rank}>{t('cup.rank')}</th>
              <th scope="col">{t('cup.participant')}</th>
              <th scope="col" className={board.num}>{t('cup.record')}</th>
              <th scope="col" className={board.num}>{t('cup.points')}</th>
              <th scope="col" className={board.num}><abbr title={t('cup.matchWinLong')}>{t('cup.matchWin')}</abbr></th>
              <th scope="col" className={board.num}><abbr title={t('cup.gameWinLong')}>{t('cup.gameWin')}</abbr></th>
              <th scope="col" className={`${board.num} ${board.breaker}`}><abbr title={t('cup.omwLong')}>OMW</abbr></th>
              <th scope="col" className={`${board.num} ${board.breaker}`}><abbr title={t('cup.ogwLong')}>OGW</abbr></th>
            </tr>
          </thead>
          <tbody>
            {cup.standings.map((entry) => {
              const archetype = entryArchetype(cup, entry);
              const played = entry.wins + entry.losses + entry.ties;
              const cut = cup.cutSize > 0 && cup.stage === 'swiss' && entry.rank === cup.cutSize;
              return (
                <tr key={entry.id} data-champion={entry.id === cup.championId || undefined} data-cut={cut || undefined}>
                  <td className={board.rank}>
                    <span className={board.rankBadge}>{entry.rank}</span>
                  </td>
                  <th scope="row">
                    <span className={board.who}>
                      {live && <i className={board.presence} data-online={entry.online || undefined}
                        title={t(entry.online ? 'cup.online' : 'cup.offline')} aria-label={t(entry.online ? 'cup.online' : 'cup.offline')} />}
                      <ArchetypeLabel name={archetype.name} colors={archetype.colors} size="md"
                        title={<EntryName entry={entry} showOwner={!owner} />} fallback={t('cup.archetypeHidden')} />
                    </span>
                    {cut && <small className={board.cut}>{t('cup.cutLine')}</small>}
                  </th>
                  <td className={board.num}>
                    <span className={board.record}>{entry.wins}–{entry.losses}–{entry.ties}</span>
                  </td>
                  <td className={board.num}><strong className={board.points}>{entry.points}</strong></td>
                  <td className={board.num}>{played ? rate(entry.wins / played) : '—'}</td>
                  <td className={board.num}>{played ? rate(entry.gw) : '—'}</td>
                  <td className={`${board.num} ${board.breaker}`}>{played ? rate(entry.omw) : '—'}</td>
                  <td className={`${board.num} ${board.breaker}`}>{played ? rate(entry.ogw) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
