import { Link } from 'react-router-dom';
import { useT } from '../i18n';
import { AgentModelLabel } from '../ui/AgentModelLabel';
import { Zone } from '../ui/Zone';
import type { Entry, Tournament } from './tournamentApi';
import styles from './TournamentScreen.module.css';

export function Identity({ entry }: { entry: Entry }) {
  const t = useT();
  return (
    <span className={styles.identity}>
      {entry.kind === 'agent' ? (
        <>
          <strong>{entry.name}</strong>
          <AgentModelLabel {...entry} />
          <span className={styles.owner}>
            {t('cup.agentOf')} <Link to={'/tournaments/owners/' + encodeURIComponent(entry.owner)}>{entry.owner}</Link>
          </span>
        </>
      ) : (
        <Link to={'/tournaments/owners/' + encodeURIComponent(entry.owner)}>
          <strong>{entry.name}</strong>
        </Link>
      )}
    </span>
  );
}
export function Roster({ cup }: { cup: Tournament }) {
  const t = useT();
  const states = {
    qualified: 'cup.qualified',
    eliminated: 'cup.eliminated',
    disqualified: 'cup.disqualified',
    absent: 'cup.absent',
  } as const;
  return (
    <Zone label={t('cup.roster')}>
      <p>{t('cup.ready', { count: cup.participants.filter((e) => e.online).length, total: cup.participants.length })}</p>
      <ul className={styles.list}>
        {cup.participants.map((entry) => (
          <li key={entry.id} className={styles.line}>
            <Identity entry={entry} />
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
export function Standings({ cup }: { cup: Tournament }) {
  const t = useT();
  return (
    <Zone label={t('cup.standings')}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t('cup.rank')}</th>
            <th scope="col">{t('cup.participant')}</th>
            <th scope="col">{t('cup.record')}</th>
            <th scope="col">{t('cup.points')}</th>
          </tr>
        </thead>
        <tbody>
          {cup.standings.map((entry) => (
            <tr key={entry.id}>
              <td>{entry.rank}</td>
              <td>
                <Identity entry={entry} />
                {cup.cutSize > 0 && cup.stage === 'swiss' && entry.rank === cup.cutSize && (
                  <small className={styles.cut}>{t('cup.cutLine')}</small>
                )}
              </td>
              <td>
                {entry.wins}–{entry.losses}–{entry.ties}
              </td>
              <td>{entry.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {cup.standings.length > 0 && (
        <details>
          <summary>{t('cup.breakers')}</summary>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t('cup.participant')}</th>
                <th>OMW%</th>
                <th>GW%</th>
                <th>OGW%</th>
              </tr>
            </thead>
            <tbody>
              {cup.standings.map((e) => (
                <tr key={e.id}>
                  <td>{e.name}{e.kind === 'agent' && <> <AgentModelLabel {...e} /></>}</td>
                  {[e.omw, e.gw, e.ogw].map((v, i) => (
                    <td key={i}>{(v * 100).toFixed(1)}%</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </Zone>
  );
}
