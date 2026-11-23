import { createHash } from 'node:crypto';
import { ToolError } from './game-seat.mjs';

const commandsBySeat = new WeakMap();
const maxCommandsPerSeat = 256;

function commandIndex(seat) {
  if (!commandsBySeat.has(seat)) commandsBySeat.set(seat, new Map());
  return commandsBySeat.get(seat);
}

function currentGameState(seat, gameId) {
  const state = seat.snapshot();
  return state.gameId === gameId ? state : null;
}

function requiresDecision(state) {
  return Boolean(state && (
    state.rollbackRequest
    || state.sideboard && !state.sideboard.submitted
    || state.decision && state.decision.kind !== 'waiting' && state.decision.choices?.length
  ));
}

async function lineResult(seat, { gameId, commandId, sequenceId }, timeoutMs, signal, awaitNextPrompt = false) {
  const deadline = performance.now() + timeoutMs;
  const key = { gameId, sequenceId };
  await seat.waitSequenceStatus(key, timeoutMs, signal);
  let receipt = seat.sequenceStatus(key);
  let state = receipt.reason === 'authorization_expired' ? null : currentGameState(seat, gameId);
  const remainingMs = Math.floor(deadline - performance.now());
  // An information update can stop execution just before the next legal prompt.
  // Observe that prompt within the original wait budget without submitting another action.
  if (awaitNextPrompt && receipt.status === 'interrupted' && receipt.reason !== 'conceded'
    && state?.status === 'active' && !requiresDecision(state) && remainingMs > 0) {
    await seat.wait({ gameId, afterCursor: state.cursor, timeoutMs: remainingMs }, signal);
    receipt = seat.sequenceStatus(key);
    state = currentGameState(seat, gameId);
  }
  const planOwnsExecution = receipt.status === 'running';
  const rollback = Boolean(state?.rollbackRequest);
  const { optionalPassStop, ...status } = receipt;
  const priorityOptions = optionalPassStop && seat.priorityOptions(optionalPassStop, state);
  return {
    ...status,
    ...(state && state.cursor !== status.cursor ? { cursor: state.cursor, progressCursor: status.cursor } : {}),
    ...(priorityOptions ? { priorityOptions } : {}),
    commandId,
    stage: 'execution',
    actionIndex: receipt.error?.actionIndex ?? receipt.actionIndex ?? null,
    planOwnsExecution,
    needsAgent: rollback || !planOwnsExecution && requiresDecision(state),
    event: rollback ? 'rollback' : receipt.status === 'ended' ? receipt.reason : planOwnsExecution ? 'line_running' : 'line_stopped',
    state,
  };
}

export function playLine(seat, { gameId, cursor, commandId, actions, expectedStackIds, declineExiledCard, waitMs, reasoning, explanation }, reauthorize, signal) {
  signal?.throwIfAborted();
  const commands = commandIndex(seat);
  const fingerprint = createHash('sha256').update(JSON.stringify([gameId, cursor, actions, expectedStackIds, reasoning, declineExiledCard, ...(explanation ? [explanation] : [])])).digest('hex');
  const known = commands.get(commandId);
  if (known) {
    if (known.fingerprint !== fingerprint) {
      const error = new ToolError('key_conflict', 'That commandId belongs to a different line. Recover it with the original request before making a new plan.');
      error.lineRejection = 'recover_original_command';
      throw error;
    }
    return lineResult(seat, known, waitMs, signal, true);
  }
  let started;
  try {
    // An exact prompt response may only select an option. Settle an announced
    // line of plays, but do not assume a choose-only line also authorizes passes.
    const settle = actions.some(({ kind }) => ['play', 'activate', 'attack'].includes(kind));
    const line = explanation ? { commandId, explanation } : reasoning ? { commandId, reasoning } : undefined;
    started = seat.startTurn({ gameId, cursor, actions, expectedStackIds, declineExiledCard, finish: 'none', settle, line }, reauthorize);
  } catch (error) {
    if (error instanceof ToolError && error.code !== 'forbidden_game') {
      error.state = currentGameState(seat, gameId);
      error.lineRejection = error.code === 'sequence_running' ? 'recover_running_command'
        : error.state ? 'replan_from_state' : 'read_current_state';
    }
    throw error;
  }

  const command = { gameId, commandId, sequenceId: started.sequenceId, fingerprint };
  commands.set(commandId, command);
  if (commands.size > maxCommandsPerSeat) commands.delete(commands.keys().next().value);
  return lineResult(seat, command, waitMs, signal, true);
}

export function waitForLine(seat, { gameId, commandId, timeoutMs = 18_000 }, signal) {
  const command = commandIndex(seat).get(commandId);
  if (!command || command.gameId !== gameId) {
    throw new ToolError('unknown_command', 'This seat has no retained line receipt for that game and commandId. Read the current game state before submitting a new action.');
  }
  return lineResult(seat, command, timeoutMs, signal);
}

// After archival, retain terminal progress only. No current projection, hand or game action
// is needed to acknowledge a command that has already stopped.
export function closedPlayerReceipts(seat) {
  const state = seat.snapshot();
  if (state.status !== 'match_over') return [];
  const results = [];
  for (const command of commandsBySeat.get(seat)?.values() ?? []) {
    if (state.gameId !== command.gameId) continue;
    let line;
    try { line = seat.sequenceStatus(command); }
    catch (error) { if (error.code === 'unknown_sequence') continue; throw error; }
    if (line.status === 'running') continue;
    results.push({ gameId: command.gameId, commandId: command.commandId, sequenceId: line.sequenceId,
      status: line.status, reason: line.reason, stage: 'execution', event: line.status === 'ended' ? line.reason : 'line_stopped',
      appliedDecisions: line.appliedDecisions, completedSteps: line.completedSteps, cursor: state.cursor,
      ...(line.cursor !== state.cursor ? { progressCursor: line.cursor } : {}),
      planOwnsExecution: false, needsAgent: false,
      state: { gameId: state.gameId, tableId: state.tableId, status: state.status, cursor: state.cursor, score: state.score } });
  }
  return results;
}
