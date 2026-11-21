import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createApi, RpcClient, EventBus, GameSession, PROMPT_EVENTS, stripMarkup, chatText, projectedChoices, commandForAgentChoice, describeAgentDecision, visibleAgentGame } from '../dist/engine-core.mjs';
import { cardCatalogEntry, formatTag } from './catalog.mjs';
import { ToolError, waitFor } from './game-seat.mjs';
import { TableConversation } from './table-conversation.mjs';

const ROLLBACK_VOTE = 'ADD_PERMISSION_TO_ROLLBACK_TURN';
// Use the normal XMage defaults for the managed MCP identity, with distinct
// upkeep on either turn, plus own draw and both end-step windows.
const MCP_USER_DATA = {
  confirmEmptyManaPool: true,
  manaPoolAutomatic: true,
  manaPoolAutomaticRestricted: true,
  autoOrderTrigger: true,
  autoTargetLevel: 1,
  useSameSettingsForReplacementEffects: true,
  userSkipPrioritySteps: {
    yourTurn: { upkeep: true, draw: true, endOfTurn: true },
    opponentTurn: { upkeep: true, endOfTurn: true },
  },
};

function rejectOnFalse(value, code, message) {
  if (value !== true) throw new ToolError(code, message);
  return value;
}

function seatTiming(view, own, decision) {
  const configured = Number.isFinite(view?.priorityTime) && view.priorityTime >= 0;
  const enabled = configured ? view.priorityTime > 0 : null;
  const reported = own?.priorityTimeLeftSecs;
  const matchClock = {
    status: enabled === false ? 'disabled' : enabled === true && typeof own?.timerActive === 'boolean'
      ? own.timerActive ? 'running' : 'paused' : 'unknown',
    // A sample of the cumulative match clock, never a deadline for this decision.
    lastReportedSecondsRemaining: enabled === true && Number.isFinite(reported) && reported >= 0 ? reported : null,
    reportedAtEpochMs: enabled === true && Number.isFinite(own?.priorityTimeSavedTimeMs) && own.priorityTimeSavedTimeMs > 0
      ? own.priorityTimeSavedTimeMs : null,
  };
  // This process shares the engine host's wall clock. Never derive idle from a match-clock sample.
  const idle = view?.myPlayerId === own?.playerId ? view?.responseIdle : null;
  const inactivity = { status: 'unknown', deadlineEpochMs: null, secondsRemaining: null, timeoutSeconds: null };
  if (idle?.status === 'running' && Number.isFinite(idle.deadlineEpochMs) && idle.deadlineEpochMs >= 0
      && Number.isFinite(idle.remainingMillis) && idle.remainingMillis >= 0 && Number.isFinite(idle.sampledAtEpochMs)) {
    inactivity.status = 'running';
    inactivity.deadlineEpochMs = idle.deadlineEpochMs;
    inactivity.secondsRemaining = Math.max(0, Math.ceil((idle.deadlineEpochMs - Date.now()) / 1000));
    // Duration of this actual server window, distinct from its decreasing remainder and any match clock.
    inactivity.timeoutSeconds = Number.isSafeInteger(idle.timeoutSeconds) && idle.timeoutSeconds >= 0 ? idle.timeoutSeconds : null;
  } else if (idle?.status === 'inactive' || idle?.status === 'disabled') {
    inactivity.status = idle.status;
  }
  const pending = decision && decision.kind !== 'waiting' && decision.choices.length > 0;
  return {
    matchClock,
    inactivity,
    warning: !pending ? null : inactivity.status === 'running'
      ? 'Your decision is pending. The server response-inactivity timer can auto-concede even with the match clock disabled. Answer a current legal choice before the reported deadline. Polling, chat and local analysis do not extend it.'
      : inactivity.status === 'disabled'
        ? 'Your decision is pending. The engine response-inactivity timer is disabled for this game; the cumulative match clock is separate. Polling does not answer the engine prompt.'
        : 'Your decision is pending. The inactivity deadline is unknown; null does not mean unlimited time. Submit a current legal choice promptly. Polling, chat and local analysis do not answer the engine prompt.',
  };
}

function poolFromView(deck) {
  const pack = (cards) => {
    const entries = new Map();
    for (const card of Object.values(cards ?? {})) {
      const cardName = card?.name;
      if (!cardName) continue;
      const setCode = card.expansionSetCode ?? '';
      const cardNumber = card.cardNumber ?? '';
      const key = JSON.stringify([cardName, setCode, cardNumber]);
      const current = entries.get(key);
      if (current) current.amount++;
      else entries.set(key, { cardName, setCode, cardNumber, amount: 1 });
    }
    return [...entries.values()];
  };
  return { name: deck.name ?? 'Match deck', cards: pack(deck.cards), sideboard: pack(deck.sideboard) };
}

export class PlaymatEngineSeat {
  #signal = new Set();
  #promptIds = new WeakMap();
  #enginePromptMessageId = null;
  #answerPromptMessageId = null;
  #answerLine = null;
  #cursor = 0;
  #epoch = randomUUID();
  #restoreToken = null;
  #connected = false;
  #allowHumanPlay = true;
  #connecting = null;
  #roomId = null;
  #tableId = null;
  #gameTableId = null;
  #session = null;
  #boardUnsubscribe = null;
  #sideboard = null;
  #vote = null;
  #chatId = null;
  #chatJoin = null;
  #chat = new TableConversation();
  #invitePresentation = null;

  constructor({ engineUrl, engineName, trustedHeader, accountId, recoverySeatId, connectionId, canonicalAgent = false, authenticationHeaders = {}, guardedPrompts = true, managedPriorityStops = false, humanTableId = null }) {
    this.engineUrl = engineUrl;
    this.managedPriorityStops = managedPriorityStops;
    this.engineName = engineName;
    this.humanTableId = humanTableId;
    if (humanTableId && humanTableId !== 'create') {
      this.#tableId = humanTableId.replace(/^start:/, '');
      this.#allowHumanPlay = !humanTableId.startsWith('start:');
    }
    this.rpc = new RpcClient({
      createSocket: (url) => new WebSocket(url, { headers: { [trustedHeader]: engineName,
        ...authenticationHeaders,
        ...(this.humanTableId ? { 'X-Playmat-Human-Table': this.humanTableId } : {}),
        ...(accountId && recoverySeatId ? { 'X-Playmat-Account': accountId, 'X-Playmat-Seat': recoverySeatId } : {}),
        ...(connectionId ? { 'X-Playmat-Connection': connectionId } : {}),
        ...(canonicalAgent ? { 'X-Playmat-Canonical-Agent': '1' } : {}),
      }, maxPayload: 4 * 1024 * 1024 }),
      requestTimeoutMs: 12_000, heartbeatTimeoutMs: 30_000, maxReconnectAttempts: 4, stateDiffs: false,
    });
    this.bus = new EventBus(this.rpc);
    const api = createApi(this.rpc);
    // The engine compares the callback ID again when it applies an action. This closes the
    // window in which a new prompt can arrive after the MCP checks the seat's projected state.
    for (const name of ['sendPlayerUUID', 'sendPlayerBoolean', 'sendPlayerString', 'sendPlayerInteger', 'sendPlayerManaType', 'sendPlayerAction']) {
      const dispatch = api[name];
      api[name] = async (...args) => {
        if (name !== 'sendPlayerAction' && guardedPrompts) {
          if (!Number.isSafeInteger(this.#answerPromptMessageId)) throw new ToolError('stale_decision', 'The engine prompt identifier is unavailable.');
          const needed = name === 'sendPlayerManaType' ? 3 : 2;
          while (args.length < needed) args.push(null);
          args.push(this.#answerPromptMessageId);
        }
        if (this.#answerLine) {
          const expected = name === 'sendPlayerManaType' ? 4 : 3;
          while (args.length < expected) args.push(null);
          args.push(this.#answerLine);
        }
        return rejectOnFalse(await dispatch(...args), 'engine_rejected', 'The engine did not accept that action.');
      };
    }
    this.api = api;
    this.bus.onAny(({ method, objectId, messageId }) => {
      if (objectId === this.#session?.getState().gameId && PROMPT_EVENTS.includes(method)) {
        this.#enginePromptMessageId = messageId;
      }
    });
    let initial = true;
    this.rpc.onStatus((status) => {
      if (status === 'reconnecting' || status === 'closed') {
        this.#connected = false;
        this.#chatId = null;
        this.#chatJoin = null;
        this.#invalidate();
      }
      if (status === 'open' && !initial) void this.#login().catch(() => this.#publish());
      if (status === 'open') initial = false;
    });
    this.bus.on('JOINED_TABLE', (message) => {
      if (!this.#acceptsTable(message?.currentTableId)) return;
      if (message?.currentTableId) this.#tableId = message.currentTableId;
      this.#publish();
    });
    this.bus.on('START_GAME', (message) => this.#joinStartedGame(message));
    this.bus.on('SIDEBOARD', (message, event) => {
      if (!message?.deck || !(message.currentTableId ?? event.objectId)
          || !this.#allowHumanPlay || !this.#acceptsTable(message.currentTableId ?? event.objectId)) return;
      this.#sideboard = {
        decisionId: randomUUID(), tableId: message.currentTableId ?? event.objectId,
        deck: poolFromView(message.deck), deadline: message.time > 0 ? Date.now() + message.time * 1000 : null, submitted: false,
      };
      this.#invalidate();
    });
    this.bus.on('USER_REQUEST_DIALOG', (request) => {
      if (request?.button1Action !== ROLLBACK_VOTE || request.gameId !== this.#session?.getState().gameId || !request.relatedUserId) return;
      const receivedAtEpochMs = Date.now();
      this.#vote = { id: request.relatedUserId, requester: request.relatedUserName ?? null, message: stripMarkup(request.message),
        requestedAtEpochMs: Number.isSafeInteger(request.requestedAtEpochMs) ? request.requestedAtEpochMs : null,
        receivedAtEpochMs };
      this.#invalidate();
    });
    this.bus.on('GAME_ROLLBACK', (_turn, event) => {
      if (event.objectId === this.#session?.getState().gameId) {
        this.#vote = null;
        this.#invalidate();
      }
    });
    this.bus.on('CHATMESSAGE', (message, event) => {
      if (!this.#chatId || event.objectId !== this.#chatId || !message?.username
          || (message.messageType && message.messageType !== 'TALK')) return;
      const own = message.username === this.engineName;
      const author = (own && this.#invitePresentation?.displayName) || message.username;
      const inserted = this.#chat.receive({ author, message: chatText(message.message), time: message.time ?? null,
        cursor: message.chatSequence }, own);
      // Wake readers without advancing the game cursor or invalidating a queued action.
      if (inserted) for (const listener of this.#signal) listener();
    });
  }

  #publish() {
    this.#cursor++;
    for (const listener of this.#signal) listener();
  }

  #invalidate() {
    this.#epoch = randomUUID();
    this.#promptIds = new WeakMap();
    this.#publish();
  }

  subscribe(listener) {
    this.#signal.add(listener);
    return () => this.#signal.delete(listener);
  }

  async #login() {
    if (this.#connecting) return this.#connecting;
    this.#connecting = (async () => {
      const login = await this.api.connectUser(this.engineName, '', this.#restoreToken, 'web');
      rejectOnFalse(login, 'engine_signin', 'This agent seat could not sign in to XMage.');
      if (!this.humanTableId) this.#restoreToken = await this.api.sessionGetRestoreToken();
      if (this.managedPriorityStops && !this.humanTableId) {
        rejectOnFalse(await this.api.connectSetUserData(null, MCP_USER_DATA, 'web', ''),
          'engine_preferences_unavailable', 'XMage could not initialize the MCP seat priority stops.');
      }
      this.#roomId = await this.api.serverGetMainRoomId();
      this.#connected = true;
      this.#publish();
      const gameId = this.#session?.getState().gameId;
      if (gameId && !this.#chatId) void this.#joinChat(gameId).catch(() => {});
    })();
    try { return await this.#connecting; }
    finally { this.#connecting = null; }
  }

  async open() {
    if (this.#connected) return;
    const status = this.rpc.getStatus();
    if (status === 'reconnecting') throw new ToolError('reconnecting', 'The engine connection is being restored.');
    if (!['open', 'connecting'].includes(status)) await this.rpc.connect(this.engineUrl);
    if (!this.#connected) await this.#login();
  }

  #acceptsTable(tableId) {
    return !this.humanTableId || this.humanTableId === tableId;
  }

  #joinStartedGame(message) {
    const { gameId, playerId, currentTableId } = message ?? {};
    if (!gameId || !playerId || !this.#allowHumanPlay || !this.#acceptsTable(currentTableId)) return;
    // Repeated recovery/reconnect notifications must not discard the already initialized view or open decision.
    const existing = this.#session?.getState();
    if (existing?.gameId === gameId && existing.playerId === playerId) return;
    this.#boardUnsubscribe?.();
    this.#session?.dispose();
    this.#enginePromptMessageId = null;
    this.#sideboard = null;
    this.#vote = null;
    this.#chatId = null;
    this.#chatJoin = null;
    this.#chat = new TableConversation();
    this.#tableId = currentTableId ?? this.#tableId;
    this.#gameTableId = this.#tableId;
    this.#session = new GameSession(this.api, this.bus, { gameId, playerId, mode: 'play' });
    this.#boardUnsubscribe = this.#session.store.subscribe(() => this.#publish());
    this.#invalidate();
    void this.api.gameJoin(gameId).then(() => this.#joinChat(gameId)).catch(() => this.#publish());
  }

  #decision(state) {
    if (!state?.prompt || this.#vote) return null;
    let id = this.#promptIds.get(state.prompt);
    if (!id) {
      id = randomUUID();
      this.#promptIds.set(state.prompt, id);
    }
    return projectedChoices(state, id);
  }

  snapshot() {
    const state = this.#session?.getState();
    const view = state?.view;
    const own = view?.players?.find((player) => player.playerId === state?.playerId);
    const priority = own?.hasPriority || view?.priorityPlayerName === this.engineName ? 'self'
      : view?.priorityPlayerName ? 'opponent' : 'none';
    const end = state?.endInfo;
    const matchEnded = end && (end.matchView?.endTime != null
      || Math.max(end.wins ?? 0, end.loses ?? 0) >= (end.winsNeeded ?? 2));
    const status = matchEnded ? 'match_over'
      : !this.#connected && this.rpc.getStatus() !== 'idle' ? 'disconnected'
      : this.#sideboard ? 'sideboarding' : state?.gameOver ? 'game_over' : state ? 'active' : 'lobby';
    const decision = status === 'active' ? this.#decision(state) : null;
    const timing = seatTiming(view, own, decision);
    const tableId = state ? this.#gameTableId : this.#tableId;
    const presentation = this.#invitePresentation?.tableId === tableId ? this.#invitePresentation : null;
    return {
      gameId: state?.gameId ?? null, tableId: this.#tableId, status, epoch: this.#epoch, cursor: this.#cursor,
      ...(presentation ? { chatMode: presentation.chatMode } : {}),
      ...(presentation?.displayName ? { displayName: presentation.displayName } : {}),
      ...visibleAgentGame(state),
      priority,
      // Compatibility alias: only the last reported running match clock, including zero.
      secondsRemaining: timing.matchClock.status === 'running' ? timing.matchClock.lastReportedSecondsRemaining : null,
      timing,
      score: state?.endInfo ? { wins: state.endInfo.wins, losses: state.endInfo.loses, winsNeeded: state.endInfo.winsNeeded } : null,
      rollbackRequest: this.#pendingRollback(),
      sideboard: this.#sideboard ? { decisionId: this.#sideboard.decisionId, submitted: this.#sideboard.submitted } : null,
      decision: describeAgentDecision(decision),
    };
  }

  async respond(decisionId, choiceId, value, line) {
    const state = this.#session?.getState();
    const decision = this.#decision(state);
    if (!decision || decision.id !== decisionId) throw new ToolError('stale_decision', 'Read the current engine decision again.');
    const choice = decision.choices.find(({ id }) => id === choiceId);
    if (!choice) throw new ToolError('illegal_choice', 'That engine choice is unavailable.');
    const command = commandForAgentChoice(choice, decision, value);
    if (!command) throw new ToolError('illegal_choice', 'The choice requires values within the given limits.');
    this.#answerPromptMessageId = this.#enginePromptMessageId;
    this.#answerLine = line;
    try {
      await this.#session.respond(command);
    } catch (error) {
      if (error.code === -32602) void this.resync(state.gameId).catch(() => {});
      throw error;
    } finally {
      this.#answerPromptMessageId = null;
      this.#answerLine = null;
    }
    return { submitted: true, gameId: state.gameId, cursor: this.#cursor };
  }

  async resync(gameId) {
    this.#requireGame(gameId);
    this.#invalidate();
    this.#enginePromptMessageId = null;
    return { requested: await this.#session.resync() };
  }

  async createGame({ name, format, deck, matchTimeLimit, seed, winsNeeded = 2, mode, botDeck, humanMcpAllowed }, register) {
    await this.open();
    const password = randomBytes(24).toString('base64url');
    await this.#validateForSeat(format, deck);
    const computer = mode === 'practice' || mode === 'bot';
    const rival = mode === 'practice' ? { name: 'Goldfish', cards: [{cardName: 'Plains', amount: 60}], sideboard: [] }
      : botDeck ?? deck;
    if (computer && rival !== deck) await this.#validateForSeat(format, rival);
    const table = await this.api.roomCreateTable(this.#roomId, {
      name, gameType: 'Two Player Duel', deckType: formatTag(format), playerTypes: ['HUMAN', computer ? 'COMPUTER_MAD' : 'HUMAN'],
      ...(this.humanTableId ? { humanMcpAllowed } : {}),
      winsNeeded, rollbackTurnsAllowed: true, rated: false, spectatorsAllowed: false, password,
      ...(matchTimeLimit ? { matchTimeLimit } : {}), ...(seed === undefined ? {} : { seed }),
    });
    if (!table?.tableId) throw new ToolError('table_failed', 'XMage could not create the table.');
    const { tableId } = table;
    if (this.humanTableId) {
      this.humanTableId = tableId;
      this.#allowHumanPlay = humanMcpAllowed === true;
    }
    try {
      await this.#joinTable(this.#roomId, tableId, deck, password);
      const access = await register?.({ tableId, roomId: this.#roomId, format, password });
      if (computer) {
        rejectOnFalse(await this.api.roomJoinTable(this.#roomId, tableId, mode === 'practice' ? 'Goldfish' : 'Bot',
          'COMPUTER_MAD', 4, rival, password), 'seat_refused', 'The computer could not join this table.');
        await this.startMatch(tableId);
      }
      return { tableId, format, state: computer ? 'started' : 'waiting', ...(access?.inviteLink ? { inviteLink: access.inviteLink } : {}) };
    } catch (error) {
      await this.api.tableRemove(this.#roomId, tableId).catch(() => {});
      throw error;
    }
  }

  async joinGame({ tableId, deck }, invitation, claim) {
    if (!invitation || invitation.tableId !== tableId || !invitation.format) {
      throw new ToolError('not_invited', 'This agent has no available invitation to that table.');
    }
    await this.open();
    await this.#validateForSeat(invitation.format.replace('Constructed - ', ''), deck);
    const grant = await claim();
    if (grant?.tableId !== tableId || grant.format !== invitation.format) {
      throw new ToolError('not_invited', 'The requested invitation changed. Use the current link.');
    }
    const roomId = grant.roomId ?? this.#roomId;
    const gameId = this.#tableId === tableId ? this.#session?.getState().gameId ?? null : null;
    try {
      await this.#joinTable(roomId, tableId, deck, grant.password ?? null);
    } catch (error) {
      // An uncertain acknowledgement or same-agent retry can already have filled this seat.
      const table = await this.api.roomGetTableById(roomId, tableId).catch(() => null);
      if (!table?.seats?.some((seat) => seat.playerName === this.engineName)) throw error;
      this.#tableId = tableId;
    }
    const chatMode = grant.mode === 'mcp' ? grant.chatMode ?? 'quiet' : null;
    this.#invitePresentation = chatMode ? { tableId, chatMode, displayName: grant.guestDisplayName } : null;
    this.#publish();
    return {
      tableId, state: 'seated', gameId,
      ...(grant.guestDisplayName ? { displayName: grant.guestDisplayName } : {}),
      ...(chatMode ? { chatMode } : {}),
    };
  }

  async #validateForSeat(format, deck) {
    const result = await this.validateDeck({ format, deck });
    if (!result?.valid) throw new ToolError('illegal_deck', 'This deck was rejected by XMage format validation.');
  }

  async #joinTable(roomId, tableId, deck, password) {
    rejectOnFalse(await this.api.roomJoinTable(roomId, tableId, this.engineName, 'HUMAN', 1, deck, password),
      'seat_refused', 'The engine refused this seat. Verify the invitation and deck.');
    this.#tableId = tableId;
    this.#publish();
  }

  async startMatch(tableId) {
    await this.open();
    if (tableId !== this.#tableId || !await this.api.tableIsOwner(this.#roomId, tableId)) {
      throw new ToolError('forbidden_match', 'Only the host of this seat’s table can start it.');
    }
    rejectOnFalse(await this.api.matchStart(this.#roomId, tableId), 'table_not_ready', 'Both seats must be ready.');
    return { tableId, started: true };
  }

  async recoveryList() { await this.open(); return this.api.recoveryList(); }
  async recoveryStatus(matchId) { await this.open(); return this.api.recoveryStatus(matchId); }
  async recoveryJoin({ matchId, revision, agree }) {
    await this.open();
    return this.api.recoveryJoin(matchId, revision, agree);
  }

  #requireGame(gameId) {
    const current = this.#session?.getState();
    if (!this.#connected || !current || (gameId && current.gameId !== gameId)) {
      throw new ToolError('forbidden_game', 'This agent does not have the requested seat.');
    }
    return current;
  }

  async concede(gameId, entireMatch) {
    this.#requireGame(gameId);
    const operation = entireMatch ? this.api.matchQuit(gameId) : this.api.sendPlayerAction('CONCEDE', gameId);
    rejectOnFalse(await operation, 'concession_refused', 'The engine did not accept the concession.');
    this.#invalidate();
    return { submitted: true };
  }

  sideboardState(gameId) {
    if (gameId) this.#requireGame(gameId);
    if (!this.#sideboard) throw new ToolError('not_sideboarding', 'This seat is not sideboarding.');
    return this.#sideboard;
  }

  async submitSideboard({ gameId, decisionId, deck }) {
    const sideboard = this.sideboardState(gameId);
    if (sideboard.submitted || sideboard.decisionId !== decisionId) throw new ToolError('stale_decision', 'Read the latest sideboard prompt.');
    sideboard.submitted = true;
    try {
      rejectOnFalse(await this.api.deckSubmit(sideboard.tableId, deck), 'sideboard_refused', 'XMage rejected the sideboard submission.');
    } catch (error) {
      sideboard.submitted = false;
      throw error;
    }
    this.#publish();
    return { submitted: true };
  }

  async requestRollback({ gameId, turnsBack }) {
    const state = this.#requireGame(gameId);
    if (!state.view?.rollbackTurnsAllowed || state.interaction.mode !== 'priority' || state.awaitingServer) {
      throw new ToolError('not_actionable', 'A rollback request requires your open priority window.');
    }
    this.#invalidate();
    rejectOnFalse(await this.api.sendPlayerAction('ROLLBACK_TURNS', gameId, turnsBack), 'rollback_refused', 'The engine refused the rollback request.');
    return { requested: true };
  }

  async voteRollback({ gameId, requestId, accept }) {
    this.#requireGame(gameId);
    if (this.#pendingRollback()?.id !== requestId) throw new ToolError('stale_rollback', 'The request is no longer current.');
    const action = accept ? ROLLBACK_VOTE : 'DENY_PERMISSION_TO_ROLLBACK_TURN';
    rejectOnFalse(await this.api.sendPlayerAction(action, gameId, requestId), 'rollback_refused', 'The engine refused the vote.');
    this.#vote = null;
    this.#invalidate();
    return { submitted: true };
  }

  #pendingRollback() {
    const vote = this.#vote;
    return vote && Date.now() - (vote.requestedAtEpochMs ?? vote.receivedAtEpochMs) < 30_000 ? vote : null;
  }

  async #joinChat(gameId) {
    if (this.#chatJoin) return this.#chatJoin;
    if (this.#chatId) return this.#chatId;
    const conversation = this.#chat;
    const join = (async () => {
      const chatId = await this.api.chatFindByGame(gameId);
      if (!chatId || this.#chatJoin !== join || this.#session?.getState().gameId !== gameId || this.#chat !== conversation) return null;
      // During chatJoin the engine can already deliver recent TALK callbacks.
      this.#chatId = chatId;
      const accepted = await this.api.chatJoin(chatId, this.engineName, true);
      if (!accepted) throw new ToolError('chat_unavailable', 'The engine could not join this game chat.');
      return this.#chat === conversation ? chatId : null;
    })();
    this.#chatJoin = join;
    try { return await join; }
    catch (error) {
      if (this.#chatJoin === join) this.#chatId = null;
      throw error;
    } finally {
      if (this.#chatJoin === join) this.#chatJoin = null;
    }
  }

  setTableChatMode(tableId, chatMode) {
    if (this.humanTableId === tableId) this.#invitePresentation = { tableId, chatMode };
  }

  chatCursor(gameId) {
    return this.#session?.getState().gameId === gameId ? this.#chat.latestOpponent : 0;
  }

  async listChat(gameId, afterCursor) {
    this.#requireGame(gameId);
    await this.#joinChat(gameId);
    this.#requireGame(gameId);
    const result = this.#chat.read(afterCursor);
    // Preserve the original list_chat message shape for callers without a cursor.
    if (afterCursor === undefined) result.messages = result.messages.map(({ cursor, ...message }) => message);
    return result;
  }

  async waitChat({ gameId, afterCursor = 0, timeoutMs = 18000 }, signal) {
    this.#requireGame(gameId);
    const chatId = await this.#joinChat(gameId);
    this.#requireGame(gameId);
    const read = state => {
      if (state.gameId !== gameId) return { event: 'game_changed', cursor: afterCursor, messages: [] };
      const result = this.#chat.read(afterCursor, true);
      if (result.messages.length) return { event: 'chat', ...result };
      if (['disconnected','match_over','sideboarding','game_over'].includes(state.status)) return { event: state.status, ...result };
      return null;
    };
    if (!chatId) {
      const ended = read(this.snapshot());
      if (ended) return ended;
      throw new ToolError('chat_unavailable', 'There is no participant chat for the current game.');
    }
    const result = await waitFor(this, read, timeoutMs, signal);
    if (result) return result;
    const state = this.snapshot();
    return read(state) ?? { event: 'timeout', ...this.#chat.read(afterCursor, true) };
  }

  async sendChat({ gameId, message }) {
    this.#requireGame(gameId);
    const chatId = await this.#joinChat(gameId);
    if (!chatId) throw new ToolError('chat_unavailable', 'There is no participant chat for the current game.');
    rejectOnFalse(await this.api.chatSendMessage(chatId, null, message), 'chat_refused', 'XMage refused this chat message.');
    return { sent: true };
  }

  async searchCards(criteria) {
    await this.open();
    return (await this.api.searchCards(criteria, { legalOnly: !!criteria.format })).map(cardCatalogEntry);
  }

  async getCard({ name, setCode = '', cardNumber = '', format }) {
    await this.open();
    const [card] = await this.api.lookupCards([{ cardName: name, setCode, cardNumber, amount: 1 }]);
    const legalPrintings = card && format ? await this.api.searchCards({
      format: formatTag(format), name: card.name, count: 1, uniqueNames: true,
    }, { legalOnly: true }) : null;
    return {
      card: cardCatalogEntry(card), engineAvailable: !!card,
      formatLegal: legalPrintings ? legalPrintings.length > 0 : null,
    };
  }

  async validateDeck({ format, deck }) {
    await this.open();
    return this.api.deckValidate(formatTag(format), deck);
  }

  close() {
    this.#boardUnsubscribe?.();
    this.#session?.dispose();
    this.bus.dispose();
    this.rpc.disconnect();
    this.#signal.clear();
  }
}
