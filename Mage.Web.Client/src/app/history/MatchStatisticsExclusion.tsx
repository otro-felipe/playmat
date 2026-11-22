import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { formatDate, useT } from '../i18n';
import { Button } from '../ui/Button';
import type { PracticeMatch } from './practiceHistory';
import styles from './PracticeHistory.module.css';

export function MatchStatisticsExclusion({ match, account }: { match: PracticeMatch; account: string }) {
  const t = useT();
  const client = useQueryClient();
  const [reason, setReason] = useState('');
  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: ['playtesting-history', account] }),
    client.invalidateQueries({ queryKey: ['playtesting-performance', account] }),
  ]);
  const mark = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/playtesting/matches/${match.id}/statistics-exclusion`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason.trim() }),
      });
      if (!response.ok) throw new Error('Match exclusion failed');
    },
    onSettled: refresh,
  });
  if (match.statisticsExclusion) {
    const { reason, author, markedAt } = match.statisticsExclusion;
    return <div className={styles.exclusionDetails}>
      <p>{reason}</p>
      <small>{t('history.exclusionAttribution', {
        author, date: formatDate(new Date(markedAt), { dateStyle: 'medium', timeStyle: 'short' }),
      })}</small>
    </div>;
  }
  if (!match.canExcludeFromStatistics) return null;
  return <details className={styles.exclusionDetails}>
    <summary>{t('history.excludeFromStats')}</summary>
    <form onSubmit={(event) => { event.preventDefault(); if (reason.trim() && !mark.isPending) mark.mutate(); }}>
      <p>{t('history.exclusionEffect')}</p>
      <label>{t('history.exclusionReason')}
        <input required maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
      </label>
      <Button size="sm" type="submit" busy={mark.isPending} disabled={!reason.trim()}>{t('history.saveExclusion')}</Button>
      {mark.isError && <p role="alert">{t('history.exclusionError')}</p>}
    </form>
  </details>;
}
