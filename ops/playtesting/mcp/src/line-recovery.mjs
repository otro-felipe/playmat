// Arguments for read-only calls are complete. A writable call is a template:
// the pilot supplies the fields in "requires" after inspecting their own state.
export function nextLineAction(receipt, { state, owner, pending, uncertain }) {
  const { gameId, appliedDecisions } = receipt;
  const progress = { appliedDecisions };
  if (state && Number.isSafeInteger(state.cursor) && state.status !== 'disconnected') progress.cursor = state.cursor;
  const decision = state?.status === 'active' && state.decision?.id && state.decision.kind !== 'waiting'
    && state.decision.choices?.length ? state.decision : null;
  if (decision && !state.rollbackRequest && !pending && !uncertain && !owner && !receipt.planOwnsExecution) progress.decisionId = decision.id;
  const action = (kind, tool, args, requires) => ({ kind, ...progress, ...(tool && { tool, arguments: args }), ...(requires && { requires }) });
  const read = { gameId, view: 'compact' };

  if (receipt.reason === 'authorization_expired') return action('authorization_ended');
  if (state?.rollbackRequest) return action('review_rollback', 'vote_rollback',
    { gameId, requestId: state.rollbackRequest.id }, ['accept']);
  if (owner?.commandId) return action('wait_for_command', 'wait_for_decision', { ...read, commandId: owner.commandId });
  if (owner?.sequenceId) return action('inspect_sequence', 'get_sequence_status', { gameId, sequenceId: owner.sequenceId });
  if (receipt.planOwnsExecution || receipt.recovery === 'recover_original_command') {
    return action('wait_for_command', 'wait_for_decision', { ...read, commandId: receipt.commandId });
  }
  if (state?.status === 'match_over' || receipt.reason === 'match_over') return action('match_finished');
  if (state?.status === 'sideboarding') return action('inspect_sideboard', 'get_sideboard_state', { gameId });
  if (state?.status === 'game_over' || receipt.reason === 'game_over') return action('read_current_game', 'get_game_state', { view: 'compact' });
  if (uncertain) return action('resync', 'resync_game', { gameId });
  if (!state || state.status !== 'active') return action('refresh_state', 'get_game_state', read);
  if (pending || !decision) return action('wait_for_decision', 'wait_for_decision', { ...read, afterCursor: state.cursor });
  if (decision.kind === 'priority') return action('plan_from_state', 'play_line', { ...read, cursor: state.cursor }, ['commandId', 'actions']);
  const required = ['commandId', 'actions[0].choiceId'];
  if (decision.choices.every(choice => choice.type === 'number' || choice.type === 'numbers')) required.push('actions[0].value');
  return action('answer_prompt', 'play_line', { ...read, cursor: state.cursor, actions: [{ kind: 'choose', decisionId: decision.id }] }, required);
}

// Scope a suggested call in exactly the same way as its originating request.
// Human and registered-player routes are selected before the game handler runs.
export function scopeLineAction(receipt, { playerId, humanTableId }) {
  const next = receipt?.nextAction;
  if (!next?.arguments || (!playerId && !humanTableId)) return receipt;
  const args = { ...next.arguments, ...(playerId && { playerId }), ...(humanTableId && { humanTableId }) };
  return { ...receipt, nextAction: { ...next, arguments: args } };
}

export function unverifiedLineAction(code, { gameId, commandId }, submitting) {
  const appliedDecisions = submitting ? 0 : null;
  switch (code) {
    case 'player_required':
      return { kind: 'select_player', appliedDecisions, tool: 'list_players', arguments: {} };
    case 'player_table_required':
      return { kind: 'inspect_reservation', appliedDecisions, tool: 'get_player_reservation', arguments: {} };
    case 'forbidden_game':
      return { kind: 'game_unavailable', appliedDecisions };
    case 'invalid_input':
      return { kind: 'correct_arguments', appliedDecisions };
    case 'forbidden':
    case 'player_forbidden':
    case 'player_busy':
    case 'assignment_closed':
      return { kind: 'seat_unavailable', appliedDecisions: null };
    case 'unknown_command':
    case 'upstream_unavailable':
      return { kind: 'refresh_state', appliedDecisions: null, tool: 'get_game_state', arguments: { gameId, view: 'compact' } };
    default:
      return { kind: 'recover_receipt', appliedDecisions: null, tool: 'wait_for_decision', arguments: { gameId, commandId, view: 'compact' } };
  }
}
