import { SpectatorBroadcast } from '../spectator/SpectatorScreen';
import { MatchHumanSeat, useEnabledHumanSeat } from '../ui/humanSeat';
import { invitedPlayerLabel } from '../playtesting';
import { useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useStore } from 'zustand';
import { useEvents } from '../stores/events';
import { useGames } from '../stores/games';
import { usePlay } from '../stores/play';
import { MatchErrorBoundary } from '../match/MatchErrorBoundary';
import { MatchStage } from '../match/MatchStage';
import { ReconnectScrim } from '../match/ReconnectScrim';
import { useMatchSiteTools } from '../match/useMatchSiteTools';
import { useSession } from '../stores/session';
import { usePlaytestingInvitation } from '../usePlaytestingInvitation';
import { Button } from '../ui/Button';
import { isSiteToolOrigin } from '../webmcp';
import styles from './GameScreen.module.css';

/** A running game: the match stage, full screen. */
export function GameScreen() {
  const { gameId = '' } = useParams();
  const navigate = useNavigate();
  const session = useGames((state) => state.sessions[gameId]);
  // games inside an event lead back to the event
  const eventId = useEvents((events) => events.currentTournamentId);
  // Career matches lead back to Career (a mode's game to that mode's screen)
  const returnPath = usePlay((play) => play.returnPath) ?? '/';
  const backLabel = eventId ? 'Back to the event' : returnPath.startsWith('/career') ? 'Back to Career' : 'Back to Play';

  if (!session) {
    return (
      <div className={styles.missing}>
        <h1>This game isn't open here</h1>
        <p>It may have ended, or it was started in another tab.</p>
        <Button variant="print" onClick={() => navigate(returnPath)}>{backLabel}</Button>
      </div>
    );
  }
  return (
    <MatchErrorBoundary
      gameId={gameId}
      backLabel={backLabel}
      onBack={() => navigate(eventId ? `/event/${eventId}` : returnPath)}
    >
      {/* each game of a match gets a fresh stage */}
      <ConnectedStage
        key={gameId}
        gameId={gameId}
        leaveLabel={backLabel}
        onLeave={() => {
          useGames.getState().close(gameId);
          navigate(eventId ? `/event/${eventId}` : returnPath);
        }}
      />
    </MatchErrorBoundary>
  );
}

function ConnectedStage({ gameId, leaveLabel, onLeave }: { gameId: string; leaveLabel: string; onLeave(): void }) {
  const session = useGames((state) => state.sessions[gameId])!;
  const tableId = useGames((state) => state.tables[gameId]?.tableId);
  const enabledHuman = useEnabledHumanSeat(tableId);
  const { data: invite } = usePlaytestingInvitation(tableId);
  const seatDisplayNames = useMemo(() => {
    if (invite?.mode !== 'mcp' || !invite.guestEngineName) return;
    const label = invitedPlayerLabel(invite);
    if (label) return { [invite.guestEngineName]: label };
  }, [invite]);
  const state = useStore(session.store);
  const connection = useSession((session) => session.connection);
  const phase = useSession((session) => session.phase);
  const serverUrl = useSession((session) => session.serverUrl);
  const loginCount = useSession((session) => session.loginCount);
  const offline = connection !== 'open';
  useMatchSiteTools(session, !state.browserInputLock && !offline && phase === 'signedIn' && isSiteToolOrigin(serverUrl), {
    key: `${gameId}:${state.playerId}:${loginCount}`,
    isCurrent() {
      const current = useSession.getState();
      return !session.getState().browserInputLock && current.connection === 'open' && current.phase === 'signedIn'
        && current.loginCount === loginCount && current.serverUrl === serverUrl
        && useGames.getState().sessions[gameId] === session;
    },
  });
  if (state.browserInputLock === 'delegated' && tableId) {
    return <SpectatorBroadcast key={tableId} tableId={tableId} humanMcpName={enabledHuman} seatDisplayNames={seatDisplayNames} onLeave={onLeave}
      endpoint={'/api/playtesting/tables/' + encodeURIComponent(tableId) + '/spectator'} />;
  }
  return (
    <>
      <MatchHumanSeat.Provider value={enabledHuman}><MatchStage session={session} state={state} seatDisplayNames={seatDisplayNames} onLeave={state.browserInputLock ? onLeave : undefined} leaveLabel={leaveLabel} /></MatchHumanSeat.Provider>
      {(offline || state.resyncing) && !state.gameOver && state.mode !== 'replay' && (
        <ReconnectScrim offline={offline} onLeave={onLeave} leaveLabel={leaveLabel} />
      )}
    </>
  );
}
