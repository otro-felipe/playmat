import { AsyncLocalStorage } from 'node:async_hooks';
import { GameSeat, ToolError } from './game-seat.mjs';

const accessDenied = () => new ToolError('human_seat_forbidden', 'Your connection cannot control the human player at this table.');

// MCP is stateless. Bind the selected seat to this call and its asynchronous line executor.
// Concurrent tool requests can independently target different players on the same account.
export const seatContext = new AsyncLocalStorage();

export function humanMatchAccess({ actor, product, createEngine, seats, maxSeats }) {
  const requireAccount = () => {
    if (!actor.accountAgent || !actor.username || !actor.scopes.includes('play') || !product) throw accessDenied();
  };
  async function policy(tableId, allowStartOnly = false) {
    requireAccount();
    let seat;
    try { seat = await product('human_seat_settings', { tableId }); }
    catch (error) {
      if (!['forbidden','not_found'].includes(error.code)) throw error;
    }
    if (seat?.tableId !== tableId || seat.humanName !== actor.username
        || !(seat.humanMcpAllowed || allowStartOnly && seat.createdViaMcp)) throw accessDenied();
    return seat;
  }
  function createSeat(tableId) {
    return new GameSeat(createEngine({ ...actor, canonicalAgent: false, engineName: actor.username,
      recoverySeatId: 'human:' + actor.accountId, humanTableId: tableId }));
  }
  const tableKey = tableId => JSON.stringify([actor.accountId, 'human', tableId, actor.connectionId]);
  function reserveRoom() {
    if (seats.size < maxSeats) return;
    for (const [key, seat] of seats) {
      if (!seat.engine.humanTableId || seat.snapshot().status !== 'match_over') continue;
      seat.invalidate('match_over');
      seat.engine.close?.();
      seats.delete(key);
      return;
    }
    throw new ToolError('capacity', 'The beta seat limit has been reached.');
  }
  async function select(tableId, action) {
    const settings = await policy(tableId);
    const key = tableKey(tableId);
    let seat = seats.get(key);
    if (!seat) {
      reserveRoom();
      seats.set(key, seat = createSeat(tableId));
    }
    try {
      await seat.engine.open();
    } catch (error) {
      if (seats.get(key) === seat) {
        seats.delete(key);
        seat.engine.close?.();
      }
      throw error;
    }
    if (settings.chatMode) seat.engine.setTableChatMode(tableId, settings.chatMode);
    const currentTable = seat.snapshot().tableId;
    if (currentTable && currentTable !== tableId) throw accessDenied();
    return seatContext.run({ seat, tableId }, action);
  }
  async function create(args, register) {
    requireAccount();
    reserveRoom();
    const seat = createSeat('create');
    const reservation = Symbol('creating human match');
    seats.set(reservation, seat);
    try {
      const result = await seat.engine.createGame(args, register);
      if (args.humanMcpAllowed) seats.set(tableKey(result.tableId), seat);
      else seat.engine.close?.();
      return { ...result, mode: args.mode, humanMcpAllowed: args.humanMcpAllowed, humanName: actor.username };
    } catch (error) {
      seat.engine.close?.();
      throw error;
    } finally {
      seats.delete(reservation);
    }
  }
  async function start(tableId) {
    const settings = await policy(tableId, true);
    const key = tableKey(tableId);
    // A disabled match's creator can finish setting up its waiting table. Its live state is never a tool result.
    const existing = seats.get(key);
    if (!existing) reserveRoom();
    const seat = existing ?? createSeat(settings.humanMcpAllowed ? tableId : 'start:' + tableId);
    try {
      const result = await seat.engine.startMatch(tableId);
      if (settings.humanMcpAllowed) seats.set(key, seat);
      else { seat.engine.close?.(); seats.delete(key); }
      return result;
    } catch (error) {
      if (!existing) seat.engine.close?.();
      throw error;
    }
  }
  return { select, create, start, policy, requireAccount };
}
