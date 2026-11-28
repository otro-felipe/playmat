// One recorder per authorized native seat. Only generated decision IDs, UUIDs,
// cursors, timing and fixed event names enter the audit stream.
export class DecisionDelivery {
  #decisions = new Map();
  #current = null;
  #assignment = null;

  constructor(record) { this.record = record; }

  observe({ gameId, tableId, seatId, cursor, assignedAt, decision }) {
    const at = Number.isSafeInteger(assignedAt) && assignedAt > 0 ? assignedAt : null;
    if (at && (this.#assignment?.gameId !== gameId || this.#assignment.at !== at)) {
      this.#assignment = { gameId, at };
      this.record({ stage: 'priority_assigned', gameId, tableId, seatId, cursor,
        priorityAssignedAtEpochMs: at, observedAtEpochMs: Date.now(), deliveryStatus: 'unconfirmed' });
    }
    if (!at) this.#assignment = null;
    const id = decision?.choices?.length ? decision.id : null;
    if (id === this.#current?.decisionId) return;
    if (this.#current) this.#emit('decision_closed', this.#current);
    this.#current = null;
    if (!id) return;
    let row = this.#decisions.get(id);
    if (!row) {
      row = { gameId, tableId, seatId, decisionId: id, openingCursor: cursor,
        priorityAssignedAtEpochMs: at, actionableAtEpochMs: Date.now(), writes: new Map(),
        responseWrittenAtEpochMs: null, deliveryConfirmedAtEpochMs: null, clientReceivedAtEpochMs: null,
        firstAcceptedAtEpochMs: null, acceptedCursor: null, acceptedBy: null };
      this.#decisions.set(id, row);
      if (this.#decisions.size > 256) this.#decisions.delete(this.#decisions.keys().next().value);
      this.#emit('actionable', row);
    }
    this.#current = row;
  }

  // Kept short in the pilot view. The archived native receipt timestamp can
  // also be correlated offline using gameId, decisionId and this opening cursor.
  reference(id) {
    const row = this.#decisions.get(id);
    return row && { openingCursor: row.openingCursor, priorityAssignedAtEpochMs: row.priorityAssignedAtEpochMs,
      actionableAtEpochMs: row.actionableAtEpochMs };
  }

  written(gameId, id, cursor) {
    const row = this.#decisions.get(id);
    // A cached line receipt can contain a decision that expired before this
    // response was flushed. Never count it as delivery of an actionable choice.
    if (!row || row !== this.#current || row.gameId !== gameId || row.writes.has(cursor)) return;
    const now = Date.now();
    row.writes.set(cursor, now);
    if (row.writes.size > 32) row.writes.delete(row.writes.keys().next().value);
    if (row.responseWrittenAtEpochMs === null) {
      row.responseWrittenAtEpochMs = now;
      this.#emit('response_written', row);
    }
  }

  confirm(gameId, id, witness) {
    const row = this.#decisions.get(id);
    if (!row || row.gameId !== gameId || row.responseWrittenAtEpochMs === null) return;
    if (witness && !row.writes.has(witness.cursor)) return;
    const now = Date.now();
    let changed = row.deliveryConfirmedAtEpochMs === null;
    row.deliveryConfirmedAtEpochMs ??= now;
    // An adapter may echo its actual receipt timestamp. It is a client
    // observation, usable only inside the server's independently observed bounds.
    if (witness && row.clientReceivedAtEpochMs === null) {
      const written = row.writes.get(witness.cursor);
      if (written !== undefined && witness.receivedAtEpochMs >= written && witness.receivedAtEpochMs <= now) {
        row.clientReceivedAtEpochMs = witness.receivedAtEpochMs;
        changed = true;
      }
    }
    if (changed) this.#emit('delivery_confirmed', row);
  }

  accepted(id, cursor, by) {
    const row = this.#decisions.get(id);
    if (!row || row.firstAcceptedAtEpochMs !== null) return;
    row.firstAcceptedAtEpochMs = Date.now();
    row.acceptedCursor = cursor;
    row.acceptedBy = by;
    this.#emit('operation_accepted', row);
  }

  #emit(stage, row) {
    const { writes, ...data } = row;
    const elapsed = (start, end) => start !== null && end !== null && end >= start ? end - start : null;
    this.record({ stage, ...data, deliveryStatus: data.deliveryConfirmedAtEpochMs === null ? 'unconfirmed' : 'confirmed',
      engineToClientMs: elapsed(data.priorityAssignedAtEpochMs, data.clientReceivedAtEpochMs),
      clientToFirstAcceptedMs: elapsed(data.clientReceivedAtEpochMs, data.firstAcceptedAtEpochMs) });
  }
}
