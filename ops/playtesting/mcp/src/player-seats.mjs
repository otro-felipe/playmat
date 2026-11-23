import { randomUUID } from 'node:crypto';
import { ToolError } from './game-seat.mjs';

const humanTools = new Set(['create_human_match', 'list_human_matches', 'list_human_decks']);
const forbidden = () => new ToolError('player_forbidden', 'This connection cannot select that Thoughtseize player or the Human Player.');

export async function resolvePlayerActor(account, playerId, verify) {
  if (playerId === undefined || playerId === account.playerId) return account;
  if (account.playerId || !account.playerSelectionEnabled || !account.connectionId) throw forbidden();
  const player = await verify(playerId);
  if (player?.playerId !== playerId || player.accountId !== account.accountId || player.connectionId !== account.connectionId) {
    throw forbidden();
  }
  return player;
}

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
    playerId: actor.playerId, reservationId, operation, ...(operation==='reserve' && joinTableId && {joinTableId}), ...(tableId && { tableId }),
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
    async begin() { await change('begin'); },
    async release() {
      if (acquired) await change('release');
    },
  };
}

export async function inspectPlayerReservation(actor, engine) {
  if (!actor.playerId) throw forbidden();
  requirePlayerControl(actor);
  const { playerId, reservationId, activeTableId: tableId } = actor;
  if (!reservationId) return { playerId, phase: 'available' };
  if (tableId) return { playerId, reservationId, tableId, phase: actor.reservationCancelPending ? 'cancelling' : 'bound' };
  if (!actor.reservationStarted) return { playerId, reservationId, phase: 'reserved' };
  return { playerId, reservationId, phase: 'uncertain', waitingTableIds: await engine().ownedWaitingTables() };
}

export async function cancelPlayerReservation(actor, { reservationId, tableId }, product, engine) {
  if (!actor.playerId) throw forbidden();
  requirePlayerControl(actor);
  if (!actor.reservationId) return { playerId: actor.playerId, phase: 'available' };
  if (actor.reservationId !== reservationId || actor.activeTableId && actor.activeTableId !== tableId) {
    throw new ToolError('reservation_changed', 'Inspect this player’s current reservation and table before cancelling.');
  }
  const change = (operation, id) => product('player_reservation', { playerId: actor.playerId, reservationId, operation,
    ...(id && { tableId: id }) });
  if (!actor.activeTableId && !actor.reservationStarted) {
    if (tableId) throw new ToolError('reservation_changed', 'This reservation has no table.');
    await change('cancel');
  } else {
    if (!tableId) throw new ToolError('reservation_uncertain', 'Keep the reservation until XMage identifies the waiting table.');
    const seat = engine();
    if (!actor.activeTableId) {
      const candidates = await seat.ownedWaitingTables();
      if (candidates.length !== 1 || candidates[0] !== tableId) throw new ToolError('reservation_uncertain', 'XMage could not confirm one owned waiting table.');
      await change('bind', tableId);
    }
    const status = await seat.waitingProfileTable(tableId);
    if (!(actor.reservationCancelPending && status === 'missing')) {
      if (status !== 'waiting') throw new ToolError('table_not_cancellable', 'Only an unclaimed, waiting host table may be cancelled.');
      await change('lock_cancel', tableId);
      await seat.removeWaitingProfileTable(tableId);
    }
    await change('cancel', tableId);
  }
  return { playerId: actor.playerId, phase: 'available' };
}
