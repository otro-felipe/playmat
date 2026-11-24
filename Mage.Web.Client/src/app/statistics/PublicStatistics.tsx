import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowUpRight, ChevronRight } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { registerMessages, useI18n, useT, type Translate } from '../i18n';
import messages from '../i18n/en/events';
import { request, tournamentApi, tournamentPath } from '../tournaments/tournamentApi';
import { Button } from '../ui/Button';
import styles from './PublicStatistics.module.css';

registerMessages(messages);

type Group = 'archetype' | 'deck';
type Color = 'W' | 'U' | 'B' | 'R' | 'G';
type Row = {
  id: string;
  name: string | null;
  format: string;
  colors: Color[] | null;
  unidentified?: boolean;
  n: number;
  wins: number;
  draws: number;
  losses: number;
};
type Statistics = {
  tournamentName: string | null;
  formats: string[];
  matches: number;
  rows: Row[];
  selected: (Row & { matchups: Row[] }) | null;
};
const colors: Color[] = ['W', 'U', 'B', 'R', 'G'];

function PaletteSymbols({
  value,
  group,
  descriptionId,
}: {
  value: Row['colors'];
  group: Group;
  descriptionId: string;
}) {
  const t = useT();
  const ordered = colors.filter((c) => value?.includes(c));
  const symbols = !value ? [] : ordered.length ? ordered : ['C'];
  const names = !value
    ? t('stats.unknownColors')
    : ordered.length
      ? ordered.map((c) => t(`stats.color.${c}`)).join(', ')
      : t('stats.colorless');
  const label = t(group === 'deck' ? 'stats.paletteDeck' : 'stats.paletteArchetype', { colors: names });
  return (
    <span
      className={styles.colors}
      role="img"
      aria-label={label}
      aria-describedby={descriptionId}
      title={label}
    >
      {symbols.length ? (
        symbols.map((c) => <i key={c} aria-hidden="true" className={`ms ms-cost ms-${c.toLowerCase()}`} />)
      ) : (
        <span aria-hidden="true" className={styles.unknown}>
          ?
        </span>
      )}
    </span>
  );
}

function PaletteLegend({ group, descriptionId }: { group: Group; descriptionId: string }) {
  const t = useT();
  return (
    <details className={styles.paletteLegend}>
      <summary>{t(group === 'deck' ? 'stats.legendDeck' : 'stats.legendArchetype')}</summary>
      <div id={descriptionId}>
        <p>{t('stats.legendSources')}</p>
        <p>{t(group === 'deck' ? 'stats.legendDeckAgreement' : 'stats.legendArchetypeAgreement')}</p>
      </div>
    </details>
  );
}

function displayNames(rows: Row[], group: Group, t: Translate): Map<string, string> {
  const labels = new Map<string, string>();
  const decks = new Map<string, Row[]>();
  for (const row of new Map(rows.map((row) => [row.id, row])).values()) {
    if (group === 'archetype') {
      labels.set(row.id, row.name || t('stats.unclassified'));
      continue;
    }
    if (row.unidentified) {
      labels.set(row.id, t('stats.unidentified'));
      continue;
    }
    const key = JSON.stringify([row.format, row.name]);
    const siblings = decks.get(key);
    if (siblings) siblings.push(row);
    else decks.set(key, [row]);
  }
  for (const siblings of decks.values()) {
    const first = siblings[0];
    if (first.name && siblings.length === 1) {
      labels.set(first.id, first.name);
      continue;
    }
    let length = 6;
    while (new Set(siblings.map((row) => row.id.slice(-length))).size < siblings.length) length++;
    for (const row of siblings)
      labels.set(row.id, `${row.name || t('stats.anonymous')} · ${row.id.slice(-length)}`);
  }
  return labels;
}

function SplitBar({ row }: { row: Row }) {
  return (
    <span aria-hidden="true" className={styles.bar}>
      <i style={{ flexGrow: row.wins }} />
      <i style={{ flexGrow: row.draws }} />
      <i style={{ flexGrow: row.losses }} />
    </span>
  );
}

function ResultTable({
  rows,
  names,
  heading,
  destination,
  selectedId,
  group,
  descriptionId,
}: {
  rows: Row[];
  names: Map<string, string>;
  heading: string;
  destination: (id: string) => string;
  selectedId?: string;
  group: Group;
  descriptionId: string;
}) {
  const t = useT();
  const locale = useI18n((s) => s.locale);
  const counts = new Intl.NumberFormat(locale);
  const rates = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  return (
    <table className={styles.table} aria-label={heading}>
      <thead>
        <tr>
          <th scope="col">{heading}</th>
          <th scope="col" className={styles.numeric}>
            <abbr title={t('stats.participations')}>N</abbr>
          </th>
          <th scope="col" className={styles.record}>
            <abbr title={t('stats.recordLong')}>{t('stats.record')}</abbr>
          </th>
          <th scope="col" className={styles.numeric}>
            {t('stats.winRate')}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <th scope="row">
              {row.id === selectedId ? (
                <span className={styles.mirror}>{t('stats.mirror')}</span>
              ) : (
                <Link id={'stats-row-' + row.id} className={styles.rowLink} to={destination(row.id)}>
                  <span>{names.get(row.id)}</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </Link>
              )}
              <div className={styles.meta}>
                <PaletteSymbols value={row.colors} group={group} descriptionId={descriptionId} />
                <span>{row.format}</span>
              </div>
            </th>
            <td className={styles.numeric}>{counts.format(row.n)}</td>
            <td className={styles.record}>
              <span
                className={styles.recordText}
                role="img"
                aria-label={t('stats.results', { w: row.wins, d: row.draws, l: row.losses })}
              >
                <b>{counts.format(row.wins)}</b>
                <span> / </span>
                <b>{counts.format(row.draws)}</b>
                <span> / </span>
                <b>{counts.format(row.losses)}</b>
              </span>
              <SplitBar row={row} />
            </td>
            <td className={styles.rate}>{row.n ? rates.format(row.wins / row.n) : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PublicStatistics() {
  const { id } = useParams();
  const descriptionId = useId();
  const location = useLocation();
  const heading = useRef<HTMLHeadingElement>(null);
  const lastView = useRef<{ key: string; scope: string; selection: string; origin: string } | null>(null);
  const t = useT();
  const locale = useI18n((s) => s.locale);
  const [search, setSearch] = useSearchParams();
  const group: Group = search.get('group') === 'deck' ? 'deck' : 'archetype';
  const format = search.get('format') || '';
  const selection = search.get('selected') || '';
  const path = id ? tournamentPath(id) + '/statistics' : '/statistics';
  const endpoint = id
    ? tournamentApi + '/' + encodeURIComponent(id) + '/statistics'
    : '/api/playtesting/statistics';
  function params(nextGroup: Group, nextFormat: string, selected?: string) {
    const query = new URLSearchParams({ group: nextGroup });
    if (nextFormat) query.set('format', nextFormat);
    if (selected) query.set('selected', selected);
    return query;
  }
  const query = params(group, format, selection).toString();
  const stats = useQuery({
    queryKey: [endpoint, query],
    queryFn: ({ signal }) => request<Statistics>(endpoint + '?' + query, undefined, signal),
  });
  const data = stats.data;
  const detail = data?.selected;
  const link = (g: Group, selected?: string) => path + '?' + params(g, format, selected);
  const groupName = t(group === 'deck' ? 'stats.decks' : 'stats.archetypes');
  const names = displayNames(
    detail ? [...(data?.rows ?? []), detail, ...detail.matchups] : (data?.rows ?? []),
    group,
    t,
  );
  const title = detail ? names.get(detail.id) : t(id ? 'stats.tournamentTitle' : 'stats.globalTitle');
  const sample = detail ? detail.n : data?.matches;
  const allRows = data?.rows ?? [];
  const tableRows = detail ? detail.matchups : allRows;
  const label = detail ? t('stats.opponent') : t(group === 'deck' ? 'stats.deck' : 'stats.archetype');
  const unavailable = !!selection && !!data && !detail;
  const scope = endpoint + '?' + params(group, format);
  useEffect(() => {
    // The target may arrive asynchronously. Focus once per navigation, never on a background refetch.
    const previous = lastView.current;
    if (!data || previous?.key === location.key) return;
    const returning = previous?.scope === scope && !!previous.selection;
    const origin = returning ? previous.origin : selection;
    if (selection) heading.current?.focus();
    else if (returning) document.getElementById('stats-row-' + origin)?.focus();
    lastView.current = { key: location.key, scope, selection, origin };
  }, [data, location.key, scope, selection]);
  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <nav className={styles.nav} aria-label={t('stats.navigation')}>
          <Link to={id ? tournamentPath(id) : '/'}>
            <ArrowLeft size={17} aria-hidden="true" />
            {id ? data?.tournamentName || t('stats.backTournament') : t('cup.home')}
          </Link>
          <Link to={id ? '/statistics?' + params(group, format) : '/tournaments'}>
            {t(id ? 'stats.globalTitle' : 'cup.all')}
            <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
        </nav>
        <header className={styles.hero}>
          <div>
            {(detail || unavailable) && (
              <Link className={styles.parentLink} to={link(group)}>
                <ArrowLeft size={14} aria-hidden="true" />
                {t('stats.backGroups', { group: groupName })}
              </Link>
            )}
            <h1 ref={heading} tabIndex={-1}>
              {title}
            </h1>
            {detail && (
              <div className={styles.meta}>
                <PaletteSymbols value={detail.colors} group={group} descriptionId={descriptionId} />
                <span>{detail.format}</span>
                <span>·</span>
                <span>{t('stats.results', { w: detail.wins, d: detail.draws, l: detail.losses })}</span>
              </div>
            )}
          </div>
          {sample != null && (
            <div className={styles.sample}>
              <strong>{new Intl.NumberFormat(locale).format(sample)}</strong>
              <span>{t(detail ? 'stats.participations' : 'stats.matches')}</span>
            </div>
          )}
        </header>
        <div className={styles.controls}>
          <nav className={styles.group} aria-label={t('stats.grouping')}>
            {(['archetype', 'deck'] as const).map((g) => (
              <Link key={g} to={link(g)} aria-current={g === group ? 'page' : undefined}>
                {t(g === 'deck' ? 'stats.decks' : 'stats.archetypes')}
              </Link>
            ))}
          </nav>
          <label className={styles.format}>
            <span>{t('stats.format')}</span>
            <select value={format} onChange={(e) => setSearch(params(group, e.target.value))}>
              <option value="">{t('stats.allFormats')}</option>
              {Array.from(new Set([...(data?.formats ?? []), ...(format ? [format] : [])])).map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
        </div>
        {stats.isPending ? (
          <p role="status" className={styles.state}>
            {t('cup.loading')}
          </p>
        ) : stats.isError ? (
          <div role="alert" className={styles.state}>
            <p>{t('stats.loadError')}</p>
            <Button onClick={() => void stats.refetch()}>{t('cup.retry')}</Button>
          </div>
        ) : unavailable ? (
          <p className={styles.state}>{t('stats.unavailable')}</p>
        ) : (
          <section className={styles.results}>
            <h2>{detail ? t('stats.matchups') : t('stats.resultsHeading')}</h2>
            {detail && <p className={styles.perspective}>{t('stats.perspective', { name: title ?? '' })}</p>}
            {(tableRows.length > 0 || detail) && (
              <PaletteLegend group={group} descriptionId={descriptionId} />
            )}
            {tableRows.length ? (
              <>
                <ResultTable
                  rows={tableRows}
                  names={names}
                  heading={label}
                  group={group}
                  descriptionId={descriptionId}
                  selectedId={detail?.id}
                  destination={(selected) => link(group, selected)}
                />
                <p className={styles.note}>{t('stats.sampleNote')}</p>
              </>
            ) : (
              <p className={styles.state}>{t(detail ? 'stats.emptyOpponents' : 'stats.empty')}</p>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
