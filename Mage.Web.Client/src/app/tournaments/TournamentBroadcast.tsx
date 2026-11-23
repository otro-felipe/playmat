import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import { registerMessages, useT } from '../i18n';
import messages from '../i18n/en/events';
import { SpectatorBroadcast, ProjectedBoard, type SpectatorSnapshot } from '../spectator/SpectatorScreen';
import { SpectatorFrame } from '../spectator/SpectatorFrame';
import { PublicBroadcast } from '../ui/usePlayerIdentity';
import { Button, ButtonLink } from '../ui/Button';
import { request, tournamentApi, tournamentPath, useTournament } from './tournamentApi';
import styles from './TournamentScreen.module.css';

registerMessages(messages);
function pairingPath(id: string, pairing: string) {
  return tournamentApi + '/' + encodeURIComponent(id) + '/pairings/' + encodeURIComponent(pairing);
}
export function TournamentWatch() {
  const { id = '', pairingId = '' } = useParams();
  const [search, setSearch] = useSearchParams();
  const t = useT();
  const cup = useTournament(id);
  const admin = !!cup.data?.viewer?.isAdmin;
  const hands = admin && search.get('hands') === '1';
  const endpoint = pairingPath(id, pairingId) + '/watch' + (hands ? '?hands=1' : '');
  return (
    <SpectatorBroadcast
      key={endpoint}
      endpoint={endpoint}
      actions={
        <>
          {admin && (
            <Button size="sm" aria-pressed={hands} onClick={() => setSearch(hands ? {} : { hands: '1' })}>
              {t('watch.bothScope')}
            </Button>
          )}
          <ButtonLink href={tournamentPath(id)} size="sm">
            {t('cup.public')}
          </ButtonLink>
        </>
      }
    />
  );
}

type ReplayIndex = { games: { gameId: string; frameCount: number }[] };
export function TournamentReplay() {
  const { id = '', pairingId = '' } = useParams();
  const endpoint = pairingPath(id, pairingId) + '/replay';
  return <Replay key={endpoint} endpoint={endpoint} back={tournamentPath(id)} />;
}
function Replay({ endpoint, back }: { endpoint: string; back: string }) {
  const t = useT();
  const [gameIndex, setGame] = useState(0);
  const [frameIndex, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const index = useQuery({
    queryKey: [endpoint],
    queryFn: ({ signal }) => request<ReplayIndex>(endpoint, undefined, signal),
    retry: false,
  });
  const game = index.data?.games[gameIndex];
  const frame = useQuery({
    queryKey: [endpoint, game?.gameId, frameIndex],
    enabled: !!game?.frameCount,
    queryFn: ({ signal }) =>
      request<SpectatorSnapshot>(
        endpoint + '?gameId=' + encodeURIComponent(game!.gameId) + '&frame=' + frameIndex,
        undefined,
        signal,
      ),
    retry: false,
    gcTime: 5000,
  });
  const last = (game?.frameCount ?? 0) - 1;
  useEffect(() => {
    if (!playing || !frame.data || frameIndex >= last) return;
    const timer = window.setTimeout(() => setFrame((i) => i + 1), 1100);
    return () => window.clearTimeout(timer);
  }, [frame.data, frameIndex, last, playing]);
  const current = frame.data;
  return (
    <PublicBroadcast.Provider value>
      <SpectatorFrame
        status={t('cup.replay')}
        actions={
          <>
            {!!game && (
              <>
                <select
                  aria-label={t('cup.replay')}
                  value={gameIndex}
                  onChange={(e) => {
                    setPlaying(false);
                    setGame(Number(e.target.value));
                    setFrame(0);
                  }}
                >
                  {index.data!.games.map((g, i) => (
                    <option key={g.gameId} value={i}>
                      {t('cup.game', { n: i + 1 })}
                    </option>
                  ))}
                </select>
                <label>
                  {t('cup.frame')}{' '}
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, last)}
                    value={frameIndex}
                    onChange={(e) => {
                      setPlaying(false);
                      setFrame(Number(e.target.value));
                    }}
                  />{' '}
                  {frameIndex + 1}/{game.frameCount}
                </label>
                <Button
                  size="sm"
                  disabled={last <= 0}
                  onClick={() => {
                    if (frameIndex === last) {
                      setFrame(0);
                      setPlaying(true);
                    } else setPlaying(!playing);
                  }}
                >
                  {t(playing && frameIndex < last ? 'cup.stopReplay' : 'cup.playReplay')}
                </Button>
              </>
            )}
            <ButtonLink href={back} size="sm">
              {t('cup.public')}
            </ButtonLink>
          </>
        }
      >
        {current?.view && current.gameId ? (
          <ProjectedBoard frame={current} gameId={current.gameId} />
        ) : (
          <p role="status" className={styles.inner}>
            {t(index.isPending || (game && frame.isFetching) ? 'cup.loading' : 'cup.noFrames')}
          </p>
        )}
      </SpectatorFrame>
    </PublicBroadcast.Provider>
  );
}
