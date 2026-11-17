import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createApi, RpcClient, EventBus, GameSession, PROMPT_EVENTS, stripMarkup, pregameChoice } from '../dist/engine-core.mjs';
import { cardCatalogEntry, formatTag } from './catalog.mjs';
import { ToolError } from './game-seat.mjs';

const MAX_MESSAGES = 50;
const ROLLBACK_VOTE = 'ADD_PERMISSION_TO_ROLLBACK_TURN';

function rejectOnFalse(value, code, message) {
  if (value !== true) throw new ToolError(code, message);
  return value;
}

function cardOnBoard(card, id) {
  if (!card) return null;
  if (card.faceDown || card.hideInfo) return { id, faceDown: true, name: 'Face-down card', tapped: !!card.tapped };
  return {
    id, name: card.name ?? card.displayName ?? 'Unnamed card', controllerId: card.controllerId,
    types: card.cardTypes ?? [], rules: card.rules?.map(stripMarkup), manaCost: card.manaCostLeftStr,
    power: card.power, toughness: card.toughness, tapped: card.tapped, counters: card.counters,
    damage: card.damage, targets: card.targets, setCode: card.expansionSetCode, cardNumber: card.cardNumber,
  };
}

function cardsOnBoard(cards) {
  return Object.entries(cards ?? {}).flatMap(([id, card]) => card ? [cardOnBoard(card, id)] : []);
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

function projectChoice(command, id, label, type, card) {
  return { id, label, type, ...(card ? { card } : {}), command };
}

function projectedChoices(state, promptId) {
  const { view, prompt, interaction } = state;
  if (!view || !prompt || state.awaitingServer || state.resyncing || state.stalled) return null;

  const playerNames = new Map((view.players ?? []).map((p) => [p.playerId, p.name]));
  const pregame = pregameChoice(prompt, {
    pregame: !view.step, clickable: interaction.clickable.keys(),
    handIds: new Set(Object.keys(view.myHand ?? {})), playerIds: new Set(playerNames.keys()),
  });

  const visible = { ...view.myHand, ...view.stack, ...(prompt.kind === 'target' ? prompt.cards : undefined) };
  for (const player of view.players ?? []) Object.assign(visible, player.battlefield, player.graveyard, player.exile);
  const buttons = [interaction.mainButton, ...interaction.secondaryButtons].filter(Boolean);
  const choices = buttons.map((button, index) => {
    if (prompt.kind === 'priority' && button.command.type === 'boolean' && button.command.value === false) {
      return projectChoice(button.command, 'pass', 'Pass', 'pass');
    }
    return projectChoice(button.command, `button-${index}`, button.label, 'button');
  });
  for (const [id, command] of interaction.clickable) {
    const card = cardOnBoard(visible[id], id);
    const legal = view.canPlayObjects?.objects?.[id];
    const manaOnly = prompt.kind === 'priority' && !!legal?.basicManaAbilities?.length
      && !legal?.basicCastAbilities?.length && !legal?.basicPlayAbilities?.length && !legal?.other?.length;
    const label = pregame === 'startingPlayer' ? id === state.playerId ? 'Play first' : 'Draw first'
      : card?.name ?? playerNames.get(id) ?? 'Choose object';
    choices.push(projectChoice(command, `object-${id}`, label, manaOnly ? 'manaAbility' : 'object', card));
  }
  const details = {};
  if (prompt.kind === 'chooseAbility') {
    prompt.choices.forEach(({ id, text }, index) => {
      const label = stripMarkup(text).replace(/^\d+\.\s*/, '') || `Ability ${index + 1}`;
      choices.push(projectChoice({ type: 'uuid', id }, `ability-${index}`, label, 'option'));
    });
    choices.push(projectChoice({ type: 'uuid', id: null }, 'cancel', 'Cancel', 'button'));
  }
  if (prompt.kind === 'chooseChoice') {
    const keys = Object.entries(prompt.choice.keyChoices ?? {});
    const options = keys.length ? keys : (prompt.choice.choices ?? []).map((label) => [label, label]);
    options.forEach(([value, label], index) => choices.push(projectChoice({ type: 'string', value }, `option-${index}`, stripMarkup(label), 'option')));
    if (!prompt.choice.required) choices.push(projectChoice({ type: 'string', value: '' }, 'skip', 'Skip', 'button'));
  }
  if (prompt.kind === 'choosePile') {
    for (const [index, pile] of [prompt.pile1, prompt.pile2].entries()) {
      const choice = projectChoice({ type: 'boolean', value: index === 0 }, `pile-${index + 1}`, `Choose pile ${index + 1}`, 'pile');
      choice.cards = pile.map((card) => cardOnBoard(card, card.id));
      choices.push(choice);
    }
  }
  if (prompt.kind === 'amount') {
    details.amount = { min: prompt.min, max: prompt.max };
    choices.push(projectChoice(null, 'amount', 'Submit an integer within the provided range', 'number'));
  }
  if (prompt.kind === 'multiAmount') {
    details.amounts = {
      min: prompt.min, max: prompt.max, items: prompt.items.map((item) => ({
        label: stripMarkup(item.message), min: item.min ?? 0, max: item.max, defaultValue: item.defaultValue,
      })),
    };
    choices.push(projectChoice(null, 'amounts', 'Submit one integer per provided item in order', 'numbers'));
    if (prompt.canCancel && !choices.some((choice) => choice.command?.type === 'string' && choice.command.value === '')) {
      choices.push(projectChoice({ type: 'string', value: '' }, 'cancel', 'Cancel', 'button'));
    }
  }
  return { id: promptId, kind: pregame ?? interaction.mode, instruction: stripMarkup(interaction.headline), choices, ...details };
}

function numericCommand(choice, decision, value) {
  const within = (n, limits) => Number.isSafeInteger(n) && n >= (limits.min ?? 0) && n <= (limits.max ?? Infinity);
  if (choice.type === 'number' && within(value, decision.amount)) return { type: 'integer', value };
  if (choice.type === 'numbers' && Array.isArray(value) && value.length === decision.amounts.items.length
    && value.every((amount, index) => within(amount, decision.amounts.items[index]))
    && within(value.reduce((a, b) => a + b, 0), decision.amounts)) {
    return { type: 'string', value: value.join(' ') };
  }
  throw new ToolError('illegal_choice', 'The choice requires values within the given limits.');
}

export class PlaymatEngineSeat {
  #signal = new Set();
  #promptIds = new WeakMap();
  #enginePromptMessageId = null;
  #answerPromptMessageId = null;
  #cursor = 0;
  #epoch = randomUUID();
  #restoreToken = null;
  #connected = false;
  #connecting = null;
  #roomId = null;
  #tableId = null;
  #session = null;
  #boardUnsubscribe = null;
  #sideboard = null;
  #vote = null;
  #chatId = null;
  #chat = [];

  constructor({ engineUrl, engineName, trustedHeader, guardedPrompts = true }) {
    this.engineUrl = engineUrl;
    this.engineName = engineName;
    this.rpc = new RpcClient({
      createSocket: (url) => new WebSocket(url, { headers: { [trustedHeader]: engineName }, maxPayload: 4 * 1024 * 1024 }),
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
        this.#invalidate();
      }
      if (status === 'open' && !initial) void this.#login().catch(() => this.#publish());
      if (status === 'open') initial = false;
    });
    this.bus.on('JOINED_TABLE', (message) => {
      if (message?.currentTableId) this.#tableId = message.currentTableId;
      this.#publish();
    });
    this.bus.on('START_GAME', (message) => this.#joinStartedGame(message));
    this.bus.on('SIDEBOARD', (message, event) => {
      if (!message?.deck || !(message.currentTableId ?? event.objectId)) return;
      this.#sideboard = {
        decisionId: randomUUID(), tableId: message.currentTableId ?? event.objectId,
        deck: poolFromView(message.deck), deadline: message.time > 0 ? Date.now() + message.time * 1000 : null, submitted: false,
      };
      this.#invalidate();
    });
    this.bus.on('USER_REQUEST_DIALOG', (request) => {
      if (request?.gameId !== this.#session?.getState().gameId || request.button1Action !== ROLLBACK_VOTE || !request.relatedUserId) return;
      this.#vote = { id: request.relatedUserId, requester: request.relatedUserName ?? null, message: stripMarkup(request.message) };
      this.#invalidate();
    });
    this.bus.on('GAME_ROLLBACK', (_turn, event) => {
      if (event.objectId === this.#session?.getState().gameId) {
        this.#vote = null;
        this.#invalidate();
      }
    });
    this.bus.on('CHATMESSAGE', (message, event) => {
      if (!this.#chatId || event.objectId !== this.#chatId || !message?.username) return;
      this.#chat.push({ author: message.username, message: stripMarkup(message.message), time: message.time ?? null });
      if (this.#chat.length > MAX_MESSAGES) this.#chat.shift();
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
      this.#restoreToken = await this.api.sessionGetRestoreToken();
      this.#roomId = await this.api.serverGetMainRoomId();
      this.#connected = true;
      this.#publish();
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

  #joinStartedGame(message) {
    const { gameId, playerId, currentTableId } = message ?? {};
    if (!gameId || !playerId) return;
    this.#boardUnsubscribe?.();
    this.#session?.dispose();
    this.#enginePromptMessageId = null;
    this.#sideboard = null;
    this.#vote = null;
    this.#chatId = null;
    this.#chat = [];
    this.#tableId = currentTableId ?? this.#tableId;
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
    const status = !this.#connected && this.rpc.getStatus() !== 'idle' ? 'disconnected'
      : this.#sideboard ? 'sideboarding' : state?.gameOver
        ? Math.max(state.endInfo?.wins ?? 0, state.endInfo?.loses ?? 0) >= (state.endInfo?.winsNeeded ?? 2) ? 'match_over' : 'game_over'
        : state ? 'active' : 'lobby';
    const decision = status === 'active' ? this.#decision(state) : null;
    return {
      gameId: state?.gameId ?? null, tableId: this.#tableId, status, epoch: this.#epoch, cursor: this.#cursor,
      turn: view?.turn ?? null, phase: view?.phase ?? null, step: view?.step ?? null, priority,
      activePlayer: view?.activePlayerName ?? null, priorityPlayer: view?.priorityPlayerName ?? null,
      secondsRemaining: own?.timerActive && own.priorityTimeLeftSecs > 0 ? own.priorityTimeLeftSecs : null,
      ownHand: cardsOnBoard(view?.myHand), stack: cardsOnBoard(view?.stack),
      players: (view?.players ?? []).map((player) => ({
        id: player.playerId, name: player.name, yourSeat: player.playerId === state?.playerId,
        life: player.life, handCount: player.handCount, libraryCount: player.libraryCount, wins: player.wins,
        battlefield: cardsOnBoard(player.battlefield), graveyard: cardsOnBoard(player.graveyard), exile: cardsOnBoard(player.exile),
        manaPool: player.playerId === state?.playerId ? player.manaPool : undefined,
      })),
      combat: (view?.combat ?? []).map((group) => ({
        attackers: cardsOnBoard(group.attackers), blockers: cardsOnBoard(group.blockers),
      })),
      score: state?.endInfo ? { wins: state.endInfo.wins, losses: state.endInfo.loses, winsNeeded: state.endInfo.winsNeeded } : null,
      rollbackRequest: this.#vote,
      sideboard: this.#sideboard ? { decisionId: this.#sideboard.decisionId, submitted: this.#sideboard.submitted } : null,
      decision: decision && { ...decision, choices: decision.choices.map(({ command, ...choice }) => choice) },
    };
  }

  async respond(decisionId, choiceId, value) {
    const state = this.#session?.getState();
    const decision = this.#decision(state);
    if (!decision || decision.id !== decisionId) throw new ToolError('stale_decision', 'Read the current engine decision again.');
    const choice = decision.choices.find(({ id }) => id === choiceId);
    if (!choice) throw new ToolError('illegal_choice', 'That engine choice is unavailable.');
    const command = choice.command ?? numericCommand(choice, decision, value);
    this.#answerPromptMessageId = this.#enginePromptMessageId;
    try {
      await this.#session.respond(command);
    } catch (error) {
      if (error.code === -32602) void this.resync(state.gameId).catch(() => {});
      throw error;
    } finally {
      this.#answerPromptMessageId = null;
    }
    return { submitted: true, gameId: state.gameId, cursor: this.#cursor };
  }

  async resync(gameId) {
    this.#requireGame(gameId);
    this.#invalidate();
    this.#enginePromptMessageId = null;
    return { requested: await this.#session.resync() };
  }

  async createGame({ name, format, deck }, register) {
    await this.open();
    const password = randomBytes(24).toString('base64url');
    await this.#validateForSeat(format, deck);
    const table = await this.api.roomCreateTable(this.#roomId, {
      name, gameType: 'Two Player Duel', deckType: formatTag(format), playerTypes: ['HUMAN', 'HUMAN'],
      winsNeeded: 2, rollbackTurnsAllowed: true, rated: false, spectatorsAllowed: false, password,
    });
    if (!table?.tableId) throw new ToolError('table_failed', 'XMage could not create the table.');
    const { tableId } = table;
    try {
      await this.#joinTable(this.#roomId, tableId, deck, password);
      const access = await register?.({ tableId, roomId: this.#roomId, format, password });
      return { tableId, format, state: 'waiting', ...(access?.inviteLink ? { inviteLink: access.inviteLink } : {}) };
    } catch (error) {
      await this.api.tableRemove(this.#roomId, tableId).catch(() => {});
      throw error;
    }
  }

  async joinGame({ tableId, deck }, grant) {
    if (!grant || grant.tableId !== tableId || !grant.format) throw new ToolError('not_invited', 'This agent has no available invitation to that table.');
    await this.open();
    await this.#validateForSeat(grant.format.replace('Constructed - ', ''), deck);
    await this.#joinTable(grant.roomId ?? this.#roomId, tableId, deck, grant.password ?? null);
    return { tableId, state: 'seated', gameId: this.#session?.getState().gameId ?? null };
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
    this.#requireGame(gameId);
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
    if (this.#vote?.id !== requestId) throw new ToolError('stale_rollback', 'The request is no longer current.');
    const action = accept ? ROLLBACK_VOTE : 'DENY_PERMISSION_TO_ROLLBACK_TURN';
    rejectOnFalse(await this.api.sendPlayerAction(action, gameId, requestId), 'rollback_refused', 'The engine refused the vote.');
    this.#vote = null;
    this.#invalidate();
    return { submitted: true };
  }

  async #joinChat(gameId) {
    const chatId = await this.api.chatFindByGame(gameId);
    if (!chatId || this.#session?.getState().gameId !== gameId) return null;
    if (this.#chatId !== chatId) {
      const joined = await this.api.chatJoin(chatId, this.engineName);
      if (!joined || this.#session?.getState().gameId !== gameId) return null;
      this.#chatId = chatId;
    }
    return chatId;
  }

  listChat(gameId) {
    this.#requireGame(gameId);
    return { messages: this.#chat.slice() };
  }

  async sendChat({ gameId, message }) {
    this.#requireGame(gameId);
    const chatId = await this.#joinChat(gameId);
    if (!chatId) throw new ToolError('chat_unavailable', 'There is no participant chat for the current game.');
    rejectOnFalse(await this.api.chatSendMessage(chatId, this.engineName, message), 'chat_refused', 'XMage refused this chat message.');
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
