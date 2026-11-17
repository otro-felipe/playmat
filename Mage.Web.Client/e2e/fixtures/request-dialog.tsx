import { createRoot } from 'react-dom/client';
import { RequestDialog } from '../../src/app/RequestDialog';
import { api, events } from '../../src/app/connection';
import '../../src/app/styles/base.css';

// A local UI fixture: responses are recorded here, never sent to a game server.
const votes: unknown[] = [];
api.sendPlayerAction = async (...args) => {
  votes.push(args);
  document.querySelector('output')!.textContent = JSON.stringify(votes);
  return true;
};
let messageId = 0;
function requestRollback() {
  events.dispatch({ method: 'USER_REQUEST_DIALOG', messageId: ++messageId, objectId: 'fixture-game', data: {
    title: 'Rollback request', message: 'Allow rollback to the start of turn 1?',
    gameId: 'fixture-game', relatedUserId: 'fixture-vote',
    button1Text: 'Accept', button1Action: 'ADD_PERMISSION_TO_ROLLBACK_TURN',
    button2Text: 'Deny', button2Action: 'DENY_PERMISSION_TO_ROLLBACK_TURN',
  } });
  events.dispatch({ method: 'USER_REQUEST_DIALOG', messageId: ++messageId, objectId: 'fixture-game', data: {
    title: 'Hand request', message: 'Show your hand?', gameId: 'fixture-game', relatedUserId: 'fixture-rival',
    button1Text: 'Reveal', button1Action: 'ADD_PERMISSION_TO_SEE_HAND_CARDS',
  } });
}

createRoot(document.getElementById('root')!).render(<>
  <button type="button" onClick={requestRollback}>Request rollback</button>
  <button type="button">Outside</button>
  <output aria-label="Votes">[]</output>
  <RequestDialog />
</>);
