// Engine chat sequences are independent of the cursor used to authorize a game action.
const CAPACITY = 50;

export class TableConversation {
  #entries = [];
  #latestOpponent = 0;
  #discardedThrough = 0;

  receive(message, own) {
    if (!message.author || !message.message) return false;
    // Legacy engines supplied only the callback order. New engines preserve sequence across reconnects.
    const cursor = Number.isSafeInteger(message.cursor) && message.cursor > 0
      ? message.cursor : (this.#entries.at(-1)?.cursor ?? 0) + 1;
    if (cursor <= this.#discardedThrough || this.#entries.some(entry => entry.cursor === cursor)) return false;
    this.#entries.push({ ...message, cursor, own });
    this.#entries.sort((a, b) => a.cursor - b.cursor);
    if (!own) this.#latestOpponent = Math.max(this.#latestOpponent, cursor);
    if (this.#entries.length > CAPACITY) this.#discardedThrough = this.#entries.shift().cursor;
    return true;
  }

  get latestOpponent() { return this.#latestOpponent; }

  read(afterCursor = 0, opponentsOnly = false) {
    const entries = this.#entries.filter(entry => entry.cursor > afterCursor && (!opponentsOnly || !entry.own));
    return {
      cursor: Math.max(afterCursor, this.#entries.at(-1)?.cursor ?? 0),
      ...(this.#discardedThrough > afterCursor ? { truncated: true } : {}),
      messages: entries.map(({ own, ...message }) => message),
    };
  }
}
