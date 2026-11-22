import { randomUUID } from 'node:crypto';
import { ToolError } from './game-seat.mjs';

const humanTools = new Set(['create_human_match', 'list_human_matches', 'list_human_decks']);
const forbidden = () => new ToolError('player_forbidden', 'This connection cannot select that Thoughtseize player or the Human Player.');

export function checkPlayerSelection(actor, { playerId, humanTableId }, name) {
  if (playerId !== undefined && playerId !== actor.playerId) throw forbidden();
  if (actor.playerId && (humanTableId !== undefined || humanTools.has(name))) throw forbidden();
}

export function requirePlayerControl(actor) {
  if (actor.playerId && (!actor.connectionId || actor.ownsReservation !== true)) {
    throw new ToolError('player_busy', 'This player is controlled by another connection or its reservation could not be verified.');
  }
}

export function samePlayerControl(actor, fresh) {
  return fresh?.playerId === actor.playerId && (!actor.playerId || (fresh.ownsReservation === true
    && fresh.connectionId === actor.connectionId && fresh.reservationId === actor.reservationId
    && fresh.activeTableId === actor.activeTableId));
}

// Execute the reservation transitions at the corresponding engine boundary. A lost
// acknowledgement after table creation/join keeps the database reservation until reconciled.
export function playerLease(actor, product, joinTableId) {
  if (!actor.playerId) return undefined;
  requirePlayerControl(actor);
  let reservationId;
  let acquired = false;
  const change = (operation, tableId) => product('player_reservation', {
    playerId: actor.playerId, reservationId, operation, ...(tableId && { tableId }),
  });
  return {
    async reserve() {
      if (actor.reservationId) {
        if (joinTableId && actor.activeTableId === joinTableId) {
          reservationId = actor.reservationId;
          return;
        }
        throw new ToolError('player_busy', 'This identity already has a reserved table. Inspect list_players before retrying.');
      }
      reservationId = randomUUID();
      await change('reserve');
      acquired = true;
    },
    async bind(tableId) {
      if (!acquired && tableId === actor.activeTableId) return;
      await change('bind', tableId);
    },
    async release() {
      if (acquired) await change('release');
    },
  };
}
