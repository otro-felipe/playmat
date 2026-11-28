import { useQuery } from '@tanstack/react-query';
import { useT } from '../i18n';
import { QualityReasonText } from '../replay/QualityReason';
import { loadReviewManifest } from '../replay/reviewData';

/** Mount inside an open tooltip or replay information dialog. The archive authorizes the actual game seats. */
export function TournamentGameQualityReason({ gameId, owner, good }: { gameId: string; owner: string; good: boolean }) {
  const t = useT();
  const { data: reason, isFetchedAfterMount, isSuccess } = useQuery({
    queryKey: ['tournament-game-quality-reason', owner, gameId],
    queryFn: async ({ signal }) => {
      const manifest = await loadReviewManifest(gameId, signal, true);
      return manifest?.gameId === gameId && typeof manifest.qualityReason === 'string' ? manifest.qualityReason : null;
    },
    gcTime: 0,
    retry: false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (isSuccess && isFetchedAfterMount && reason) return <QualityReasonText reason={reason} />;
  return good ? null : <p>{t('quality.poorHint')}</p>;
}
