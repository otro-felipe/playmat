import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronRight, Clock3, ExternalLink, Trophy } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { registerMessages, useT } from '../i18n';
import messages from '../i18n/en/events';
import { Button, ButtonLink } from '../ui/Button';
import { Zone } from '../ui/Zone';
import { RegisteredAgents } from '../social/OwnerAgents';
import { AdminControls, CreateTournamentForm, Registration } from './TournamentForms';
import {
  request,
  tournamentApi,
  tournamentPath,
  useTournament,
  useTournamentOwner,
  type Tournament,
  type TournamentList,
} from './tournamentApi';
import { Countdown } from './Countdown';
import { EliminationBracket, Tables } from './TournamentPairings';
import { Identity, Roster, Standings } from './TournamentStandings';
import styles from './TournamentScreen.module.css';

registerMessages(messages);

function Frame({ children, index = false }: { children: ReactNode; index?: boolean }) {
  const t = useT();
  return (
    <main className={styles.page}>
      <div className={styles.inner}>
        <nav className={styles.nav}>
          <Link to={index ? '/' : '/tournaments'}>
            <ArrowLeft size={16} aria-hidden="true" />
            {t(index ? 'cup.home' : 'cup.all')}
          </Link>
        </nav>
        {children}
      </div>
    </main>
  );
}
function Head({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <header className={styles.head}>
      {subtitle && <p className={styles.kicker}>{subtitle}</p>}
      <h1 className={styles.title}>{title}</h1>
    </header>
  );
}
function LoadState({ error, retry }: { error?: Error | null; retry(): void }) {
  const t = useT();
  return error ? (
    <div role="alert">
      <p>
        {t('cup.error')} {error.message}
      </p>
      <Button onClick={retry}>{t('cup.retry')}</Button>
    </div>
  ) : (
    <p role="status">{t('cup.loading')}</p>
  );
}
export function TournamentsScreen() {
  const t = useT();
  const [create, setCreate] = useState(false);
  const list = useQuery({
    queryKey: ['tournament-list'],
    queryFn: ({ signal }) => request<TournamentList>(tournamentApi, undefined, signal),
    refetchInterval: 15_000,
  });
  return (
    <Frame index>
      <Head title={t('cup.title')} />
      {!list.data ? (
        <LoadState error={list.error} retry={() => void list.refetch()} />
      ) : (
        <>
          {list.data.mayCreate &&
            (create ? (
              <Zone label={t('cup.create')}>
                <CreateTournamentForm close={() => setCreate(false)} structures={list.data.attendanceStructures ?? []} />
              </Zone>
            ) : (
              <div>
                <Button variant="decision" onClick={() => setCreate(true)}>
                  {t('cup.create')}
                </Button>
              </div>
            ))}
          {list.data.tournaments.length ? (
            <ul className={styles.list}>
              {list.data.tournaments.map((cup) => (
                <li key={cup.id} className={styles.line}>
                  <Link className={styles.indexLink} to={tournamentPath(cup.id)}>
                    <span>
                      <strong>{cup.name}</strong>
                      <br />
                      <small>
                        {cup.format} · {t('cup.count', { count: cup.registeredCount, capacity: cup.capacity })}
                      </small>
                    </span>
                    <span className={styles.row}>
                      {t(`cup.${cup.status}`)}
                      <ChevronRight size={16} aria-hidden="true" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p>{t('cup.empty')}</p>
          )}
        </>
      )}
    </Frame>
  );
}
function TournamentState({ cup }: { cup: Tournament }) {
  const t = useT();
  const pairs = cup.pairings.filter((p) => p.roundNumber === cup.roundNumber && p.b);
  const finished = pairs.filter((p) => p.completed).length;
  const deadline = cup.status === 'break' ? cup.nextRoundAt : cup.status === 'playing' ? cup.deadlineAt : null;
  const champion = cup.participants.find((e) => e.id === cup.championId);
  return (
    <section className={styles.hero}>
      <div className={styles.stack}>
        {champion ? (
          <div className={styles.winner}>
            <Trophy size={26} aria-hidden="true" />
            <div>
              <small>{t('cup.champion')}</small>
              <Identity entry={champion} />
            </div>
          </div>
        ) : (
          <strong className={styles.status}>{t(`cup.${cup.status}`)}</strong>
        )}
        {cup.status === 'registration' || !cup.roundNumber ? (
          <p>{t('cup.count', { count: cup.participants.length, capacity: cup.capacity })}</p>
        ) : cup.status === 'paused' && cup.nextSessionAt ? (
          <p>
            {t('cup.nextDay')} · {new Date(cup.nextSessionAt).toLocaleString()}
          </p>
        ) : (
          <p>
            {cup.stage === 'playoffs'
              ? t('cup.stagePlayoffs') + ' · ' + t('cup.number', { n: cup.roundNumber })
              : t('cup.round', { n: cup.roundNumber, total: cup.roundsTotal })}
          </p>
        )}
      </div>
      {pairs.length > 0 && (
        <div>
          <p>{t('cup.tablesDone', { count: finished, total: pairs.length })}</p>
          <progress aria-label={t('cup.tables')} className={styles.progress} value={finished} max={pairs.length} />
        </div>
      )}
      {deadline && (
        <div className={styles.clock}>
          <Clock3 size={20} aria-hidden="true" />
          {t(cup.status === 'break' ? 'cup.nextRound' : 'cup.roundClock')}
          <Countdown at={deadline} expired={t(cup.status === 'break' ? 'cup.starting' : 'cup.extraTurns')} />
        </div>
      )}
    </section>
  );
}
function ParticipantPresence({ cup }: { cup: Tournament }) {
  const own = cup.participants.find((e) => e.kind === 'human' && cup.viewer?.entryIds?.includes(e.id));
  const id = cup.id,
    active =
      !!own &&
      cup.status !== 'finished' &&
      cup.status !== 'cancelled' &&
      !['disqualified', 'eliminated', 'absent'].includes(own.state);
  useEffect(() => {
    if (!active) return;
    const abort = new AbortController();
    let timer: number | undefined;
    async function heartbeat() {
      try {
        await request(tournamentApi + '/' + encodeURIComponent(id) + '/wait', {}, abort.signal);
      } catch {
        /* retry while the participant tab is open */
      }
      if (!abort.signal.aborted) timer = window.setTimeout(heartbeat, 10_000);
    }
    void heartbeat();
    return () => {
      abort.abort();
      window.clearTimeout(timer);
    };
  }, [active, id]);
  return null;
}
export function TournamentScreen({ admin = false }: { admin?: boolean }) {
  const { id = '' } = useParams();
  const t = useT();
  const [section, setSection] = useState<'tables' | 'standings' | 'roster'>('tables');
  const detail = useTournament(id);
  const cup = detail.data;
  if (!cup)
    return (
      <Frame>
        <LoadState error={detail.error} retry={() => void detail.refetch()} />
      </Frame>
    );
  if (admin && !cup.viewer?.isAdmin)
    return (
      <Frame>
        <p role="alert">{t('cup.forbidden')}</p>
      </Frame>
    );
  const entries = new Map(cup.participants.map((e) => [e.id, e]));
  const own = cup.participants.filter((e) => cup.viewer?.entryIds?.includes(e.id));
  return (
    <Frame>
      <Head
        title={cup.name}
        subtitle={[
          cup.format,
          t(cup.template === 'worlds' ? 'cup.worlds' : cup.cut === 'none' ? 'cup.none' : 'cup.attendance'),
          t(cup.coaching ? 'cup.coachingOpen' : 'cup.autonomous'),
        ].join(' · ')}
      />
      {(admin || cup.viewer?.isAdmin) && (
        <div className={styles.actions}>
          <ButtonLink
            className={styles.toolbarLink}
            href={tournamentPath(id) + (admin ? '' : '/admin')}
            target="_blank"
            rel="noopener"
            icon={<ExternalLink size={14} />}
          >
            {t(admin ? 'cup.public' : 'cup.admin')}
          </ButtonLink>
        </div>
      )}
      <TournamentState cup={cup} />
      {own.some((e) => e.kind === 'human' && ['registered', 'active', 'qualified'].includes(e.state)) &&
        !['finished', 'cancelled'].includes(cup.status) && (
          <div>
            <ButtonLink variant="decision" href={tournamentPath(id) + '/play'} target="_blank" rel="noopener">
              {t('cup.openSeat')} <ExternalLink size={14} />
            </ButtonLink>
          </div>
        )}
      {admin ? (
        <AdminControls cup={cup} refresh={() => void detail.refetch()} />
      ) : (
        <>
          <ParticipantPresence cup={cup} />
          {cup.status === 'registration' && (
            <Zone label={t('cup.register')}>
              <Registration
                key={cup.viewer?.accountName ?? cup.viewer?.username}
                cup={cup}
                refresh={() => void detail.refetch()}
              />
            </Zone>
          )}
          {!!own.length && cup.status !== 'registration' && (
            <Zone label={t('cup.mySeats')}>
              <ul className={styles.list}>
                {own.map((e) => {
                  const p = cup.pairings.find((p) => p.roundNumber === cup.roundNumber && (p.a === e.id || p.b === e.id));
                  return (
                    <li className={styles.line} key={e.id}>
                      <Identity entry={e} />
                      <span>
                        {e.rank && '#' + e.rank} · {e.points} {t('cup.points')}
                      </span>
                      {p?.playUrl && !p.completed ? (
                        <ButtonLink href={tournamentPath(id) + '/play'} target="_blank" rel="noopener">
                          {t('cup.openSeat')}
                        </ButtonLink>
                      ) : (
                        p?.watchUrl &&
                        !p.completed && (
                          <Link to={p.watchUrl} className={styles.link}>
                            {t('cup.live')}
                          </Link>
                        )
                      )}
                    </li>
                  );
                })}
              </ul>
            </Zone>
          )}
        </>
      )}
      {cup.stage === 'playoffs' && <EliminationBracket cup={cup} entries={entries} />}
      {cup.status !== 'registration' && (
        <div className={styles.mobileTabs} aria-label={t('cup.title')}>
          {(cup.stage === 'playoffs' && !cup.roundsTotal
            ? (['standings', 'roster'] as const)
            : (['tables', 'standings', 'roster'] as const)
          ).map((tab) => (
            <Button
              key={tab}
              size="sm"
              aria-pressed={
                section === tab ||
                (section === 'tables' && cup.stage === 'playoffs' && !cup.roundsTotal && tab === 'standings')
              }
              onClick={() => setSection(tab)}
            >
              {t(tab === 'roster' ? 'cup.roster' : tab === 'tables' ? 'cup.tables' : 'cup.standings')}
            </Button>
          ))}
        </div>
      )}
      <div className={styles.grid}>
        <div className={styles.stack}>
          {cup.status !== 'registration' && (
            <div
              className={
                section === 'standings' || (section === 'tables' && cup.stage === 'playoffs' && !cup.roundsTotal)
                  ? ''
                  : styles.desktopPanel
              }
            >
              <Standings cup={cup} />
            </div>
          )}
          <div className={section === 'roster' || cup.status === 'registration' ? '' : styles.desktopPanel}>
            <Roster cup={cup} />
          </div>
        </div>
        <div className={section === 'tables' || cup.status === 'registration' ? '' : styles.desktopPanel}>
          <Tables cup={cup} entries={entries} />
        </div>
      </div>
      {!!cup.deckLists?.length && (
        <Zone label={t('cup.decks')}>
          {cup.deckLists.map((deck) => (
            <details key={deck.entryId}>
              <summary>
                {entries.get(deck.entryId)?.name} · {deck.name}
              </summary>
              <ul>
                {deck.cards.map((c, i) => (
                  <li key={i}>
                    {c.amount} × {c.cardName}
                  </li>
                ))}
              </ul>
              {!!deck.sideboard.length && (
                <>
                  <h3>{t('cup.sideboard')}</h3>
                  <ul>
                    {deck.sideboard.map((c, i) => (
                      <li key={i}>
                        {c.amount} × {c.cardName}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </details>
          ))}
        </Zone>
      )}
    </Frame>
  );
}
export function TournamentOwnerScreen() {
  const { alias = '' } = useParams();
  const t = useT();
  const profile = useTournamentOwner(alias);
  if (!profile.data)
    return (
      <Frame>
        <LoadState error={profile.error} retry={() => void profile.refetch()} />
      </Frame>
    );
  const p = profile.data;
  return (
    <Frame>
      <Head title={p.owner} subtitle={t('cup.profile')} />
      <Zone label={t('cup.trophies')}>
        {p.trophies.length ? (
          <ul className={styles.list}>
            {p.trophies.map((row) => (
              <li className={styles.line} key={row.tournamentId}>
                <Trophy size={22} aria-hidden="true" />
                <Link to={tournamentPath(row.tournamentId)}>{row.name}</Link>
                <span>
                  {t(row.kind === 'agent' ? 'cup.ownerAward' : 'cup.champion')} · {row.entryName}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p>{t('cup.noTrophies')}</p>
        )}
      </Zone>
      <Zone label={t('cup.agents')}>
        <RegisteredAgents agents={p.agents} />
      </Zone>
      {(['human', 'agent'] as const).map((kind) => {
        const events = p.participations.filter((e) => e.kind === kind);
        return (
          <Zone key={kind} label={t(kind === 'human' ? 'cup.humanHistory' : 'cup.agentHistory')}>
            {events.length ? (
              <ul className={styles.list}>
                {events.map((e, i) => (
                  <li key={i} className={styles.line}>
                    <Link to={tournamentPath(e.tournamentId)}>{e.name}</Link>
                    <span>
                      {e.entryName}
                      {e.champion && ' · ' + t('cup.champion')}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>{t('cup.never')}</p>
            )}
          </Zone>
        );
      })}
    </Frame>
  );
}
