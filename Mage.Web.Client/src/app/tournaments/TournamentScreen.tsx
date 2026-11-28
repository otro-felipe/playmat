import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChartColumn, ChevronRight, Clock3, ExternalLink, Layers, ListOrdered, Trophy, UserRound } from 'lucide-react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { registerMessages, useT } from '../i18n';
import messages from '../i18n/en/events';
import { AgentModelLabel } from '../ui/AgentModelLabel';
import { ArchetypeLabel } from '../ui/Archetype';
import { archetypeIdentity, archetypeStyle } from '../ui/archetypeIdentity';
import { DeckListView } from '../ui/DeckListView';
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
import { EntryName, Roster, Standings } from './TournamentStandings';
import { entryArchetype, sharedOwner } from './tournamentEntries';
import { StatisticsPanel } from '../statistics/PublicStatistics';
import { tournamentTab, visibleTabs, type Tab } from './tournamentTabs';
import styles from './TournamentScreen.module.css';
import board from './TournamentBoard.module.css';

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
          {index && <Link to="/statistics">{t('shell.nav.statistics')}</Link>}
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
  const archetype = champion && entryArchetype(cup, champion);
  const identity = archetype ? archetypeIdentity(archetype.name, archetype.colors) : null;
  return (
    <section className={[styles.hero, champion ? styles.championHero : ''].join(' ')} style={identity ? archetypeStyle(identity.colors) : undefined}>
      <div className={styles.stack}>
        {champion && archetype ? (
          <div className={styles.winner}>
            <Trophy size={30} aria-hidden="true" className={styles.trophy} />
            <div className={styles.winnerText}>
              <small>{t('cup.champion')}</small>
              <ArchetypeLabel name={archetype.name} colors={archetype.colors} size="xl"
                title={<EntryName entry={champion} showOwner={!sharedOwner(cup)} />} fallback={t('cup.archetypeHidden')} />
            </div>
          </div>
        ) : (
          <strong className={styles.status}>{t(cup.voidedAt != null ? 'cup.voided' : `cup.${cup.status}`)}</strong>
        )}
      </div>
      <div className={styles.heroFacts}>
        <p className={styles.heroRound}>
          {cup.status === 'registration' || !cup.roundNumber
            ? t('cup.count', { count: cup.participants.length, capacity: cup.capacity })
            : cup.status === 'paused' && cup.nextSessionAt
              ? t('cup.nextDay') + ' · ' + new Date(cup.nextSessionAt).toLocaleString()
              : cup.stage === 'playoffs'
                ? t('cup.stagePlayoffs') + ' · ' + t('cup.number', { n: cup.roundNumber })
                : t('cup.round', { n: cup.roundNumber, total: cup.roundsTotal })}
        </p>
        {pairs.length > 0 && cup.status !== 'cancelled' && (
          <div className={styles.heroProgress}>
            <span>{t('cup.tablesDone', { count: finished, total: pairs.length })}</span>
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
      </div>
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
const tabIcons = { bracket: ListOrdered, mine: UserRound, stats: ChartColumn, decklists: Layers } as const;

function TournamentTabs({ tab, tabs, choose }: { tab: Tab; tabs: Tab[]; choose(tab: Tab): void }) {
  const t = useT();
  return (
    <div className={styles.tabs} role="tablist" aria-label={t('cup.tabs')}>
      {tabs.map((name) => {
        const Icon = tabIcons[name];
        return (
          <button
            key={name}
            type="button"
            role="tab"
            id={'cup-tab-' + name}
            aria-controls={'cup-panel-' + name}
            aria-selected={tab === name}
            tabIndex={tab === name ? 0 : -1}
            className={styles.tab}
            onClick={() => choose(name)}
            onKeyDown={(event) => {
              const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
              if (!step) return;
              const next = tabs[(tabs.indexOf(name) + step + tabs.length) % tabs.length];
              choose(next);
              document.getElementById('cup-tab-' + next)?.focus();
            }}
          >
            <Icon size={16} aria-hidden="true" />
            {t(`cup.tab.${name}`)}
          </button>
        );
      })}
    </div>
  );
}

/** Every published list: pick a participant on the left, read the list on the right. */
function DeckLists({ cup, entries }: { cup: Tournament; entries: Map<string, Tournament['participants'][number]> }) {
  const t = useT();
  const [search, setSearch] = useSearchParams();
  if (!cup.deckLists?.length) return <p className={styles.pending}>{t('cup.decklistsPending')}</p>;
  const ranked = [...cup.deckLists].sort((a, b) => (entries.get(a.entryId)?.rank ?? 99) - (entries.get(b.entryId)?.rank ?? 99));
  const deck = ranked.find((d) => d.entryId === search.get('deck')) ?? ranked[0];
  const entry = entries.get(deck.entryId);
  const owner = sharedOwner(cup);
  const pick = (id: string) => {
    const next = new URLSearchParams(search);
    next.set('deck', id);
    setSearch(next, { replace: true, preventScrollReset: true });
  };
  return (
    <div className={board.decks}>
      <ul className={board.deckPicker} aria-label={t('cup.decks')}>
        {ranked.map((d) => {
          const who = entries.get(d.entryId);
          return (
            <li key={d.entryId}>
              <button type="button" className={board.deckPick} aria-pressed={d.entryId === deck.entryId} onClick={() => pick(d.entryId)}>
                <ArchetypeLabel name={d.archetype} colors={who?.colors} title={who?.name ?? d.name} fallback={t('cup.archetypeHidden')} />
              </button>
            </li>
          );
        })}
      </ul>
      <article className={board.deckSheet} style={archetypeStyle(archetypeIdentity(deck.archetype, entry?.colors).colors)}
        aria-label={t('cup.deckOf', { name: entry?.name ?? deck.name })}>
        <header className={board.deckHead}>
          <ArchetypeLabel name={deck.archetype} colors={entry?.colors} size="lg"
            title={entry ? <EntryName entry={entry} showOwner={!owner} /> : deck.name} fallback={t('cup.archetypeHidden')} />
          {entry && <span className={board.statusPill}>#{entry.rank} · {entry.wins}–{entry.losses}–{entry.ties}</span>}
        </header>
        <p className={board.deckName}>{deck.name}</p>
        <DeckListView main={deck.cards.map((c) => ({ name: c.cardName, amount: c.amount }))}
          sideboard={deck.sideboard.map((c) => ({ name: c.cardName, amount: c.amount }))} />
      </article>
    </div>
  );
}

/** The viewer's own participants (agents and, when they played, themselves) with their place and table. */
function MyParticipants({ cup, own }: { cup: Tournament; own: Tournament['participants'] }) {
  const t = useT();
  const id = cup.id;
  return (
    <ul className={board.mine}>
      {own.map((e) => {
        const p = cup.pairings.find((p) => p.roundNumber === cup.roundNumber && (p.a === e.id || p.b === e.id));
        const archetype = entryArchetype(cup, e);
        return (
          <li key={e.id} className={board.mineCard} style={archetypeStyle(archetypeIdentity(archetype.name, archetype.colors).colors)}>
            <div>
              <span className={board.kind}>{t(e.kind === 'agent' ? 'cup.kindAgent' : 'cup.kindHuman')}</span>
              <ArchetypeLabel name={archetype.name} colors={archetype.colors} size="lg"
                title={<EntryName entry={e} showOwner={false} />} fallback={t('cup.archetypeHidden')} />
            </div>
            <dl className={board.figures}>
              <div><dt>{t('cup.rank')}</dt><dd>{e.rank ? '#' + e.rank : '—'}</dd></div>
              <div><dt>{t('cup.record')}</dt><dd>{e.wins}–{e.losses}–{e.ties}</dd></div>
              <div><dt>{t('cup.points')}</dt><dd>{e.points}</dd></div>
            </dl>
            <div className={board.tableActions}>
              {p?.playUrl && !p.completed ? (
                <ButtonLink href={tournamentPath(id) + '/play'} target="_blank" rel="noopener">{t('cup.openSeat')}</ButtonLink>
              ) : p?.watchUrl && !p.completed ? (
                <Link to={p.watchUrl} className={board.fullReplay}>{t('cup.live')}</Link>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function TournamentScreen({ admin = false }: { admin?: boolean }) {
  const { id = '' } = useParams();
  const t = useT();
  const { pathname } = useLocation();
  const [search, setSearch] = useSearchParams();
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
  const tabs = visibleTabs(own.length > 0);
  const tab = tournamentTab(search.get('tab'), own.length > 0);
  // Each tab starts clean; statistics filters belong to the statistics tab only.
  const choose = (next: Tab) => setSearch(next === 'bracket' ? {} : { tab: next });
  return (
    <Frame>
      <Head
        title={cup.name}
        subtitle={<>
          {[
            cup.format,
            t(cup.template === 'worlds' ? 'cup.worlds' : cup.cut === 'none' ? 'cup.none' : 'cup.attendance'),
            t(cup.coaching ? 'cup.coachingOpen' : 'cup.autonomous'),
          ].join(' · ')}
          {sharedOwner(cup) && cup.participants.length > 0 && <>
            {' · '}
            {cup.participants.every((e) => e.kind === 'agent') ? t('cup.agentOf') + ' ' : ''}
            <Link className={styles.ownerLink} to={'/tournaments/owners/' + encodeURIComponent(sharedOwner(cup)!)}>{sharedOwner(cup)}</Link>
          </>}
        </>}
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
        </>
      )}
      <TournamentTabs tab={tab} tabs={tabs} choose={choose} />
      <div role="tabpanel" id={'cup-panel-' + tab} aria-labelledby={'cup-tab-' + tab} className={styles.tabPanel}>
        {tab === 'bracket' && (
          <>
            {cup.status === 'registration' || !cup.standings.length ? <Roster cup={cup} /> : <Standings cup={cup} />}
            {cup.stage === 'playoffs' && <EliminationBracket cup={cup} entries={entries} />}
            {cup.status !== 'registration' && <Tables cup={cup} entries={entries} />}
          </>
        )}
        {tab === 'mine' && <MyParticipants cup={cup} own={own} />}
        {tab === 'stats' &&
          (cup.status === 'finished' ? (
            <StatisticsPanel tournamentId={id} path={pathname} scope={{ tab: 'stats' }} headingLevel={2} />
          ) : (
            <p className={styles.pending}>{t('cup.statsPending')}</p>
          ))}
        {tab === 'decklists' && <DeckLists cup={cup} entries={entries} />}
      </div>
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
                  {row.kind === 'agent' && <> <AgentModelLabel {...row} /></>}
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
                      {e.kind === 'agent' && <> <AgentModelLabel {...e} /></>}
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
