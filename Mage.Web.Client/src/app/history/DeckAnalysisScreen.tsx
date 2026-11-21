import * as Tabs from '@radix-ui/react-tabs';
import { ArrowLeft } from 'lucide-react';
import { useLocation, useSearchParams, Link } from 'react-router-dom';
import { registerMessages, useT } from '../i18n';
import messages from '../i18n/en/replay';
import { useSession } from '../stores/session';
import { Button } from '../ui/Button';
import { AnalysisOverview, MatchupResults, MulliganResults } from './PerformanceResults';
import { usePerformance } from './performance';
import page from './PracticeHistory.module.css';
import styles from './DeckAnalysis.module.css';

registerMessages(messages);
const tabs = ['overview', 'mulligan', 'matchups'] as const;

export function DeckAnalysisScreen() {
  const account = useSession((state) => state.userName);
  return <Analysis key={account} account={account} />;
}

function Analysis({ account }: { account: string }) {
  const t = useT();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  const result = usePerformance(account, search);
  const data = result.data;
  const tab = tabs.find((value) => value === search.get('tab')) ?? 'overview';
  const archetype = search.get('ownArchetype');
  const format = search.get('format');
  const deckId = search.get('deckId') ?? (search.has('scope') ? '' : data?.selected.deckId ?? '');
  const deck = data?.decks.find((entry) => entry.id === deckId);
  const group = data?.groups.find((entry) => entry.format === format && entry.archetype === archetype);
  const families = group ? data?.decks.filter((entry) => group.deckIds.includes(entry.id)) : data?.decks;
  const versions = [...new Set(deck?.versions.filter((entry) => (!format || entry.format === format)
    && (!group || entry.archetype === group.archetype)).map((entry) => entry.version))].sort((a, b) => b - a);
  const currentScope = search.get('scope');
  const version = currentScope === 'deck' ? '' : search.get('version') ?? String(deck?.currentVersion ?? '');
  const bestOf = search.get('bestOf') || '';
  const bo1 = bestOf === '1' || (!bestOf && data?.observedBestOf?.length === 1 && data.observedBestOf[0] === 1);
  const unknownOpponent = search.get('opponentArchetypeUnknown') === 'true';
  // Encoding the menu values keeps "unknown" distinct from every possible archetype label.
  const opponent = unknownOpponent ? 'unknown' : search.has('opponentArchetype') ? 'named:' + search.get('opponentArchetype') : '';
  const historySearch = location.state?.historySearch ?? '';

  function change(values: Record<string, string | undefined>) {
    const next = new URLSearchParams(search);
    for (const [name, value] of Object.entries(values)) {
      if (value) next.set(name, value);
      else next.delete(name);
    }
    // Commit this filter before another control composes its update from the URL.
    setSearch(next, { state: { historySearch }, preventScrollReset: true, flushSync: true });
  }

  return <div className={page.page}>
    <Link className={styles.back} to={'/history' + historySearch}><ArrowLeft size={15} aria-hidden="true" />{t('perf.back')}</Link>
    <header className={styles.head}>
      {format && <span className={styles.eyebrow}>{format === 'Unknown' ? t('history.unreported') : format}</span>}
      <h1>{archetype || (search.has('ownArchetypeUnknown') ? t('perf.unclassified') : deck?.archetype ?? t('perf.analysis'))}</h1>
    </header>
    {data && <div className={styles.filters}>
      <label>{t('perf.deck')}
        <select value={deckId} onChange={({ target }) => {
          const selectedDeck = families?.find((entry) => entry.id === target.value);
          if (!selectedDeck) return change({ deckId: undefined, version: undefined, scope: 'archetype' });
          const current = !group || (selectedDeck.format === group.format && selectedDeck.archetype === group.archetype);
          change({ deckId: selectedDeck.id, version: current ? String(selectedDeck.currentVersion) : undefined, scope: current ? undefined : 'deck' });
        }}>
          <option value="">{t('perf.wholeArchetype')}</option>
          {families?.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
      </label>
      {deck && <label>{t('history.version')}
        <select value={version} onChange={({ target }) => change({ deckId: deck.id, version: target.value, scope: target.value ? undefined : 'deck' })}>
          <option value="">{t('perf.allVersions')}</option>
          {versions.map((version) =>
            <option key={version} value={version}>v{version}{version === deck.currentVersion && ' · ' + t('perf.current')}</option>)}
        </select>
      </label>}
      <label>{t('perf.mode')}
        <select value={bestOf} onChange={({ target }) => change({ bestOf: target.value })}>
          <option value="">{t('perf.allModes')}</option><option value="1">Bo1</option><option value="3">Bo3</option>
        </select>
      </label>
      <label>{t('perf.opponent')}
        <select value={opponent} onChange={({ target }) => change({
          opponentArchetype: target.value.startsWith('named:') ? target.value.slice(6) : undefined,
          opponentArchetypeUnknown: target.value === 'unknown' ? 'true' : undefined,
        })}>
          <option value="">{t('perf.allOpponents')}</option>
          {data.options.opponentArchetypes.map((name) => <option key={name} value={'named:' + name}>{name}</option>)}
          <option value="unknown">{t('perf.unclassified')}</option>
        </select>
      </label>
    </div>}
    <Tabs.Root value={tab} onValueChange={(tab) => change({ tab: tab === 'overview' ? undefined : tab })}>
      <Tabs.List aria-label={t('perf.analysis')} className={styles.tabList}>
        {tabs.map((value) => <Tabs.Trigger key={value} value={value}>{t(`perf.${value}`)}</Tabs.Trigger>)}
      </Tabs.List>
      {result.isPending || result.isPlaceholderData ? <p role="status" className={page.empty}>{t('history.loading')}</p> :
        result.isError ? <div role="alert" className={page.empty}>{t('history.statsError')} <Button size="sm" onClick={() => void result.refetch()}>{t('replay.retry')}</Button></div> :
        data && <>
          <Tabs.Content value="overview"><AnalysisOverview data={data} bo1={bo1} /></Tabs.Content>
          <Tabs.Content value="mulligan"><MulliganResults data={data} /></Tabs.Content>
          <Tabs.Content value="matchups"><MatchupResults data={data} bo1={bo1} /></Tabs.Content>
        </>}
    </Tabs.Root>
  </div>;
}
