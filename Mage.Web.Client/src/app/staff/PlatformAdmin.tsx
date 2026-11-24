import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Bot, Search, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { registerMessages, useI18n, useT } from '../i18n';
import messages from '../i18n/en/events';
import { AgentModelLabel } from '../ui/AgentModelLabel';
import type { AgentModel } from '../ui/agentModel';
import { Button } from '../ui/Button';
import styles from './PlatformAdmin.module.css';

registerMessages(messages);

export interface AdminPlayer {
  id: string;
  displayName: string;
  flag: string | null;
  mcpEnabled: boolean;
  provider: AgentModel['provider'];
  model: string | null;
  reasoningEffort: string | null;
  retiredAt: string | null;
  engineName: string;
  matches: number;
  lastGameAt: number | null;
  decks: number;
}
export interface AdminGrant {
  engineName: string;
  scopes: string[];
  oauthManaged: boolean;
  playerId: string | null;
  createdAt: string | null;
  revokedAt: string | null;
}
export interface AdminAccount {
  id: string;
  username: string;
  email: string | null;
  enabled: boolean;
  tournamentAdmin: boolean;
  personalDecks: number;
  agentDecks: number;
  unclassifiedDecks: number;
  humanMatches: number;
  lastHumanGameAt: number | null;
  sessionExpiresAt: string | null;
  players: AdminPlayer[];
  grants: AdminGrant[];
}
interface Overview {
  accounts: AdminAccount[];
  totals: { accounts: number; enabledAccounts: number; players: number; activeGrants: number };
}
interface PendingDeck {
  accountId: string;
  username: string;
  deckId: string;
  library: string;
  name: string;
  format: string;
  playerName: string | null;
  mainCount: number;
}
interface Pending {
  decks: PendingDeck[];
  archetypes: Record<string, string[]>;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', ...init });
  if (!response.ok) {
    const error = new Error(response.status === 403 ? 'forbidden' : String(response.status)) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return response.json() as Promise<T>;
}

function When({ at }: { at: number | string | null }) {
  const locale = useI18n((s) => s.locale);
  if (at == null) return <>—</>;
  const date = new Date(at);
  return <time dateTime={date.toISOString()}>{date.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })}</time>;
}

function Players({ players }: { players: AdminPlayer[] }) {
  const t = useT();
  if (!players.length) return <p className={styles.muted}>{t('staff.noPlayers')}</p>;
  return (
    <div className={styles.scroll}>
      <table className={styles.table}>
        <caption>{t('staff.players')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('staff.player')}</th>
            <th scope="col">{t('staff.model')}</th>
            <th scope="col">{t('staff.engineName')}</th>
            <th scope="col" className={styles.numeric}>{t('staff.matches')}</th>
            <th scope="col" className={styles.numeric}>{t('staff.decks')}</th>
            <th scope="col">{t('staff.lastGame')}</th>
          </tr>
        </thead>
        <tbody>
          {players.map((player) => (
            <tr key={player.id} className={player.retiredAt ? styles.retired : undefined}>
              <th scope="row">
                <Bot size={14} aria-hidden="true" /> {player.displayName}
                {player.retiredAt && <span className={styles.badge}>{t('staff.retired')}</span>}
                {!player.mcpEnabled && !player.retiredAt && <span className={styles.badge}>{t('staff.mcpOff')}</span>}
              </th>
              <td>
                <AgentModelLabel provider={player.provider} model={player.model} />
                {player.reasoningEffort && <small className={styles.muted}> · {player.reasoningEffort}</small>}
              </td>
              <td><code>{player.engineName}</code></td>
              <td className={styles.numeric}>{player.matches}</td>
              <td className={styles.numeric}>{player.decks}</td>
              <td><When at={player.lastGameAt} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Grants({ grants }: { grants: AdminGrant[] }) {
  const t = useT();
  if (!grants.length) return null;
  return (
    <div className={styles.scroll}>
      <table className={styles.table}>
        <caption>{t('staff.grants')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('staff.engineName')}</th>
            <th scope="col">{t('staff.scopes')}</th>
            <th scope="col">{t('staff.created')}</th>
            <th scope="col">{t('staff.state')}</th>
          </tr>
        </thead>
        <tbody>
          {grants.map((grant) => (
            <tr key={grant.engineName + grant.createdAt} className={grant.revokedAt ? styles.retired : undefined}>
              <th scope="row"><code>{grant.engineName}</code>{grant.oauthManaged && <span className={styles.badge}>OAuth</span>}</th>
              <td>{grant.scopes.join(', ')}</td>
              <td><When at={grant.createdAt} /></td>
              <td>{grant.revokedAt ? <>{t('staff.revoked')} <When at={grant.revokedAt} /></> : t('staff.active')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AccountRow({ account }: { account: AdminAccount }) {
  const t = useT();
  const active = account.players.filter((player) => !player.retiredAt);
  return (
    <details className={styles.account}>
      <summary>
        <span className={styles.who}>
          <strong>{account.username}</strong>
          {account.tournamentAdmin && (
            <span className={styles.badge}>
              <ShieldCheck size={12} aria-hidden="true" /> {t('staff.adminBadge')}
            </span>
          )}
          {!account.enabled && <span className={styles.badge}>{t('staff.disabled')}</span>}
          {account.email && <small className={styles.muted}>{account.email}</small>}
        </span>
        <span className={styles.facts}>
          <span>{t('staff.playerCount', { count: active.length })}</span>
          <span>{t('staff.deckCount', { count: account.personalDecks + account.agentDecks })}</span>
          <span>{t('staff.matchCount', { count: account.humanMatches })}</span>
        </span>
      </summary>
      <div className={styles.body}>
        <dl className={styles.summary}>
          <div><dt>{t('staff.personalDecks')}</dt><dd>{account.personalDecks}</dd></div>
          <div><dt>{t('staff.agentDecks')}</dt><dd>{account.agentDecks}</dd></div>
          <div><dt>{t('staff.unclassified')}</dt><dd>{account.unclassifiedDecks}</dd></div>
          <div><dt>{t('staff.lastGame')}</dt><dd><When at={account.lastHumanGameAt} /></dd></div>
          <div><dt>{t('staff.session')}</dt><dd><When at={account.sessionExpiresAt} /></dd></div>
        </dl>
        <Players players={account.players} />
        <Grants grants={account.grants} />
      </div>
    </details>
  );
}

function Curation() {
  const t = useT();
  const client = useQueryClient();
  const pending = useQuery({ queryKey: ['staff-unclassified'], queryFn: () => call<Pending>('/api/playtesting/admin/decks/unclassified') });
  const [choices, setChoices] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: ({ deck, archetype }: { deck: PendingDeck; archetype: string }) =>
      call(`/api/playtesting/admin/decks/${deck.accountId}/${encodeURIComponent(deck.deckId)}/archetype`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archetype }),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['staff-unclassified'] });
      void client.invalidateQueries({ queryKey: ['staff-accounts'] });
    },
  });
  if (!pending.data) return <p role="status">{t('cup.loading')}</p>;
  const { decks, archetypes } = pending.data;
  return (
    <section className={styles.section} aria-labelledby="staff-curation">
      <h2 id="staff-curation">{t('staff.curation')}</h2>
      <p className={styles.muted}>{t('staff.curationHelp')}</p>
      {decks.length ? (
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('staff.deck')}</th>
                <th scope="col">{t('staff.owner')}</th>
                <th scope="col">{t('stats.format')}</th>
                <th scope="col">{t('stats.archetype')}</th>
              </tr>
            </thead>
            <tbody>
              {decks.map((deck) => {
                const key = deck.accountId + '/' + deck.deckId;
                const options = (archetypes[deck.format] ?? []).filter((label) => label !== 'Other');
                return (
                  <tr key={key}>
                    <th scope="row">
                      {deck.name}
                      <small className={styles.muted}> · {t('staff.mainCount', { count: deck.mainCount })}</small>
                    </th>
                    <td>
                      {deck.username}
                      {deck.playerName && <small className={styles.muted}> · {deck.playerName}</small>}
                    </td>
                    <td>{deck.format}</td>
                    <td>
                      <form
                        className={styles.assign}
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (choices[key]) save.mutate({ deck, archetype: choices[key] });
                        }}
                      >
                        <select
                          aria-label={t('staff.archetypeFor', { name: deck.name })}
                          value={choices[key] ?? ''}
                          onChange={(event) => setChoices({ ...choices, [key]: event.target.value })}
                        >
                          <option value="" disabled>{t('staff.choose')}</option>
                          {options.map((label) => <option key={label}>{label}</option>)}
                        </select>
                        <Button size="sm" type="submit" disabled={!choices[key] || save.isPending}>{t('staff.save')}</Button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p>{t('staff.allClassified')}</p>
      )}
      {save.isError && <p role="alert">{t('staff.saveError')}</p>}
    </section>
  );
}

/** Platform administration: every account, its MCP players (subagents) and grants, and deck curation. */
export function PlatformAdmin() {
  const t = useT();
  const [filter, setFilter] = useState('');
  const overview = useQuery({ queryKey: ['staff-accounts'], queryFn: () => call<Overview>('/api/playtesting/admin/accounts'), retry: false });
  const accounts = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = overview.data?.accounts ?? [];
    if (!needle) return all;
    return all.filter((account) =>
      [account.username, account.email ?? '', ...account.players.map((player) => player.displayName), ...account.grants.map((grant) => grant.engineName)]
        .some((text) => text.toLowerCase().includes(needle)),
    );
  }, [filter, overview.data]);
  const forbidden = (overview.error as { status?: number } | null)?.status;
  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <nav className={styles.nav}>
          <Link to="/">
            <ArrowLeft size={16} aria-hidden="true" />
            {t('cup.home')}
          </Link>
        </nav>
        <header className={styles.head}>
          <h1>{t('staff.title')}</h1>
          {overview.data && (
            <dl className={styles.totals}>
              <div><dt>{t('staff.accounts')}</dt><dd>{overview.data.totals.accounts}</dd></div>
              <div><dt>{t('staff.activePlayers')}</dt><dd>{overview.data.totals.players}</dd></div>
              <div><dt>{t('staff.activeGrants')}</dt><dd>{overview.data.totals.activeGrants}</dd></div>
            </dl>
          )}
        </header>
        {forbidden === 401 || forbidden === 403 ? (
          <p role="alert">{t('staff.forbidden')}</p>
        ) : overview.isError ? (
          <div role="alert">
            <p>{t('staff.loadError')}</p>
            <Button onClick={() => void overview.refetch()}>{t('cup.retry')}</Button>
          </div>
        ) : !overview.data ? (
          <p role="status">{t('cup.loading')}</p>
        ) : (
          <>
            <section className={styles.section} aria-labelledby="staff-accounts">
              <div className={styles.toolbar}>
                <h2 id="staff-accounts">{t('staff.accounts')}</h2>
                <label className={styles.search}>
                  <Search size={15} aria-hidden="true" />
                  <input
                    type="search"
                    value={filter}
                    placeholder={t('staff.search')}
                    aria-label={t('staff.search')}
                    onChange={(event) => setFilter(event.target.value)}
                  />
                </label>
              </div>
              {accounts.map((account) => <AccountRow key={account.id} account={account} />)}
              {!accounts.length && <p className={styles.muted}>{t('staff.noMatch')}</p>}
            </section>
            <Curation />
          </>
        )}
      </div>
    </main>
  );
}
