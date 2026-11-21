import { useEffect, useState } from 'react';
import { stripMarkup } from '../core/game/prompt';
import type { PlayerAction, UserRequestMessage } from '../protocol/generated/views';
import { api, events } from './connection';
import { useGames } from './stores/games';
import { useSession } from './stores/session';
import { humanSeatQuery } from './ui/humanSeat';
import { queryClient } from './queries';
import { PRIVATE_PLAYTESTING } from './playtesting';
import { Button } from './ui/Button';
import { Dialog } from './ui/Dialog';

async function browserMayAnswer(request: UserRequestMessage) {
  if (!PRIVATE_PLAYTESTING || (!request.gameId && !request.tableId)) return true;
  const games = useGames.getState();
  const tableId = request.tableId || (request.gameId && games.tables[request.gameId]?.tableId);
  const { userName, phase } = useSession.getState();
  if (phase !== 'signedIn' || !tableId) return false;
  try {
    const delegate = await queryClient.fetchQuery(humanSeatQuery(userName, tableId));
    return delegate !== userName.trim().toLowerCase() && useSession.getState().userName === userName;
  } catch { return false; }
}

/** Answers to a request, for the actions the client handles itself rather than sending to the server. */
function answer(action: PlayerAction, request: UserRequestMessage) {
  switch (action) {
    case 'CLIENT_CONCEDE_GAME':
      if (request.gameId) return api.sendPlayerAction('CONCEDE', request.gameId, null);
      return;
    case 'CLIENT_QUIT_TOURNAMENT':
    case 'CLIENT_QUIT_DRAFT_TOURNAMENT':
      if (request.tournamentId) return api.tournamentQuit(request.tournamentId);
      return;
    case 'CLIENT_REMOVE_TABLE':
      if (request.roomId && request.tableId) return api.tableRemove(request.roomId, request.tableId);
      return;
    default:
      // the remaining client actions belong to the desktop client (downloads, exit); permissions go to the server
      if (action.startsWith('CLIENT_') || !request.gameId) return;
      return api.sendPlayerAction(action, request.gameId, request.relatedUserId ?? null);
  }
}

/**
 * Questions the server asks outside a game prompt: an opponent asking to see your hand or to roll back a turn.
 * They queue and show one at a time, wherever the player is.
 */
export function RequestDialog() {
  const [queue, setQueue] = useState<UserRequestMessage[]>([]);
  useEffect(() => {
    let active = true;
    let pending = Promise.resolve();
    const stop = events.on('USER_REQUEST_DIALOG', (request) => {
      if (!request) return;
      if (!PRIVATE_PLAYTESTING) setQueue((current) => [...current, request]);
      else pending = pending.then(async () => {
        if (active && await browserMayAnswer(request) && active) setQueue((current) => [...current, request]);
      });
    });
    return () => { active = false; stop(); };
  }, []);
  const request = queue[0];
  const rollback = [request?.button1Action, request?.button2Action, request?.button3Action].some((action) =>
    action === 'ADD_PERMISSION_TO_ROLLBACK_TURN' || action === 'DENY_PERMISSION_TO_ROLLBACK_TURN');
  const close = () => setQueue((current) => current.slice(1));
  const buttons = request
    ? ([
      [request.button1Text, request.button1Action],
      [request.button2Text, request.button2Action],
      [request.button3Text, request.button3Action],
    ] as const).filter((button): button is readonly [string, PlayerAction] => !!button[0] && !!button[1])
    : [];

  return (
    <Dialog
      open={!!request}
      onOpenChange={(open) => !open && !rollback && close()}
      dismissible={!rollback}
      title={stripMarkup(request?.title) || 'Request'}
      description={stripMarkup(request?.message)}
      width="sm"
      footer={buttons.length > 0 ? (
        <>
          {buttons.map(([label, action], index) => (
            <Button
              key={action}
              variant={index === buttons.length - 1 ? 'decision' : 'quiet'}
              onClick={() => {
                void browserMayAnswer(request!).then((allowed) => allowed ? answer(action, request!) : undefined).catch(() => undefined);
                close();
              }}
            >
              {label}
            </Button>
          ))}
        </>
      ) : <Button variant="decision" onClick={close}>OK</Button>}
    >
      {null}
    </Dialog>
  );
}
