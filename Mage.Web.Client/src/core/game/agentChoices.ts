import type { AbilityType, CardView, ManaType, PermanentView, StackAbilityView } from '../../protocol/generated/views';
import type { GameSessionState } from './gameSession';
import type { Command } from './interaction';
import { pregameChoice } from './pregame';
import { stripMarkup } from './prompt';
import { splitRules } from './glossary';
import { isTriggerOrderPrompt } from './autoAnswer';

/** An allowlisted view of a card for both MCP transports. Face-down cards keep their public object ID. */
function cardOnBoard(card: CardView, id: string | undefined, ownBattlefield = false) {
  const { tapped, damage, enteringSpellId, zoneChangeCounter } = card as PermanentView;
  if (card.faceDown || card.hideInfo) return { id, faceDown: true, name: 'Face-down card', tapped: !!tapped };
  const text = splitRules(card);
  const source = (card as StackAbilityView).sourceCard;
  // Only the announced ability and public source object ID; never copy the source's hidden identity/text.
  const publicAbility = ['TRIGGERED_NONMANA', 'TRIGGERED_MANA', 'ACTIVATED_NONMANA', 'ACTIVATED_MANA'].includes(card.abilityType ?? '');
  return {
    id,
    cardId: card.cardId,
    name: card.name ?? card.displayName ?? 'Unnamed card',
    controllerId: card.controllerId,
    ...(ownBattlefield && zoneChangeCounter != null ? { zoneChangeCounter } : {}),
    ...(ownBattlefield && enteringSpellId ? { enteringSpellId } : {}),
    ...(publicAbility ? {
      abilityType: card.abilityType,
      sourceId: source?.id,
      abilityText: card.rules?.[0] ? stripMarkup(card.rules[0]) : undefined,
    } : {}),
    types: card.cardTypes ?? [],
    ...(card.isToken ? { isToken: true } : {}),
    ...(card.preparedFromId ? { preparedFromId: card.preparedFromId } : {}),
    rules: text.rules.map(stripMarkup),
    hints: text.hints,
    manaCost: card.manaCostLeftStr,
    power: card.power,
    toughness: card.toughness,
    tapped,
    counters: card.counters,
    damage,
    targets: card.targets,
    setCode: card.expansionSetCode,
    cardNumber: card.cardNumber,
  };
}

function cardsOnBoard(cards: Record<string, CardView> | undefined, ownBattlefield = false) {
  return Object.entries(cards ?? {}).flatMap(([id, card]) => card ? [cardOnBoard(card, id, ownBattlefield)] : []);
}

/** Explicit projection: future diagnostic/private engine fields never enter the agent contract. */
function sequenceEvidence(view: GameSessionState['view'] | undefined, playerId?: string | null) {
  const evidence = view?.sequenceEvidence;
  if (!evidence) return null;
  const impulse = evidence.ownImpulseExile;
  const own = playerId && view?.players?.find(player => player.playerId === playerId);
  const source = own && impulse?.sourceId && own.battlefield?.[impulse.sourceId];
  const exiled = own && impulse?.cardId && own.exile?.[impulse.cardId];
  return {
    ...(source && !source.faceDown && !source.hideInfo && exiled && !exiled.faceDown && !exiled.hideInfo && impulse ? { ownImpulseExile: {
      stackId: impulse.stackId, sourceId: impulse.sourceId, cardId: impulse.cardId, informationRevision: impulse.informationRevision,
    } } : {}),
    epoch: evidence.epoch,
    publicActions: evidence.publicActions ? { ...evidence.publicActions } : undefined,
    resolutions: evidence.resolutions ? { ...evidence.resolutions } : undefined,
    resolutionRevision: evidence.resolutionRevision,
    combatRevision: evidence.combatRevision,
    combatExileReplacements: evidence.combatExileReplacements ? { ...evidence.combatExileReplacements } : undefined,
    combatDamage: evidence.combatDamage?.map(({ revision, sourceId, controllerId, targetId, amount, targetPermanent }) =>
      ({ revision, sourceId, controllerId, targetId, amount, ...(targetPermanent ? { targetPermanent } : {}) })),
    informationRevision: evidence.informationRevision,
  };
}

/** The game state visible to the authenticated seat, with public counts for every other hand. */
export function visibleAgentGame(state: GameSessionState | undefined) {
  const view = state?.view;
  return {
    turn: view?.turn ?? null,
    phase: view?.phase ?? null,
    step: view?.step ?? null,
    activePlayer: view?.activePlayerName ?? null,
    activePlayerId: view?.activePlayerId ?? null,
    sequenceEvidence: sequenceEvidence(view, state?.playerId),
    priorityPlayer: view?.priorityPlayerName ?? null,
    ownHand: cardsOnBoard(view?.myHand),
    revealed: (view?.revealed ?? []).map((group) => ({ name: group.name, cards: cardsOnBoard(group.cards) })),
    // GameView includes lookedAt only for this viewer; never read opponentHands/watchedHands.
    lookedAt: (view?.lookedAt ?? []).map((group) => ({ name: group.name, cards: cardsOnBoard(group.cards) })),
    stack: cardsOnBoard(view?.stack).map((card) => {
      if (!('rules' in card) || !card.rules) return card;
      // CardView and StackAbilityView append selected modes after the printed rules.
      const prefix = 'Chosen mode: ';
      const selectedModeRules = card.rules.filter((rule) => rule.startsWith(prefix)).map((rule) => rule.slice(prefix.length));
      const casting = card.types?.some((type) => type === 'INSTANT' || type === 'SORCERY')
        && card.id && view?.stack?.[card.id]?.paid === false;
      const spellTargetGroups = card.controllerId === state?.playerId && card.id
        ? view?.stack?.[card.id]?.spellTargetGroups : undefined;
      return {
        ...card,
        ...(spellTargetGroups ? { spellTargetGroups } : {}),
        ...(selectedModeRules.length ? { selectedModeRules } : {}),
        ...(casting ? { unpaid: true } : {}),
      };
    }),
    players: (view?.players ?? []).map((player) => ({
      id: player.playerId,
      name: player.name,
      ...(player.userData?.flagName ? { flagName: player.userData.flagName } : {}),
      yourSeat: player.playerId === state?.playerId,
      life: player.life,
      counters: (player.counters ?? []).map(({ name, count }) => ({ name, count })),
      handCount: player.handCount,
      libraryCount: player.libraryCount,
      topCard: player.topCard ? cardOnBoard(player.topCard, player.topCard.id) : undefined,
      wins: player.wins,
      battlefield: cardsOnBoard(player.battlefield, !!state?.playerId && player.playerId === state.playerId),
      graveyard: cardsOnBoard(player.graveyard),
      exile: cardsOnBoard(player.exile),
      manaPool: player.playerId === state?.playerId ? player.manaPool : undefined,
    })),
    combat: (view?.combat ?? []).map((group) => ({
      defenderId: group.defenderId,
      isBlocked: group.isBlocked,
      attackers: cardsOnBoard(group.attackers),
      blockers: cardsOnBoard(group.blockers),
    })),
  };
}

const manaSymbols = { WHITE: 'W', BLUE: 'U', BLACK: 'B', RED: 'R', GREEN: 'G', COLORLESS: 'C' } as const;
type ManaColor = typeof manaSymbols[keyof typeof manaSymbols];

function colorSymbols(colors?: ManaType[]): ManaColor[] | undefined {
  const symbols = colors?.flatMap((color) => color in manaSymbols ? [manaSymbols[color as keyof typeof manaSymbols]] : []);
  return symbols?.length ? symbols : undefined;
}

interface AgentChoice {
  id: string;
  label: string;
  type: 'pass' | 'button' | 'manaAbility' | 'object' | 'option' | 'pile' | 'number' | 'numbers';
  command: Command | null;
  card?: ReturnType<typeof cardOnBoard>;
  cards?: ReturnType<typeof cardOnBoard>[];
  objectId?: string;
  triggerSourceId?: string;
  canPlayLand?: true;
  abilityType?: AbilityType;
  abilityId?: string;
  spellName?: string;
  manaColors?: ManaColor[];
  plainMana?: boolean;
  manaAbilities?: { abilityId: string; manaColors?: ManaColor[] }[];
  spellAbilities?: { abilityId: string; label?: string }[];
  nonManaAbilities?: { abilityId: string; label?: string; abilityText?: string }[];
  answer?: boolean;
  intent?: 'attack_all' | 'confirm_attack' | 'confirm_block' | 'confirm_targets';
}

// XMage abbreviates its priority labels before expanding {this}. Compare in the
// same representation so a cut inside the marker still matches the printed rule.
export function publicActivationText(card: { name?: string; rules?: string[] }, label: string | undefined,
  abilities: { label?: string }[]) {
  if (!label || abilities.filter((ability) => ability.label === label).length !== 1) return undefined;
  const abbreviated = label.endsWith('...');
  const prefix = abbreviated ? label.slice(0, -3) : label;
  if (!prefix) return undefined;
  const matches = (value: string) => abbreviated ? value.startsWith(prefix) : value === prefix;
  const rules = card.rules?.filter((rule) => matches(rule) || (card.name && matches(rule.replaceAll(card.name, '{this}'))));
  return rules?.length === 1 ? rules[0] : undefined;
}

type Limits = { min?: number; max?: number };
type Amounts = Limits & { items: Array<Limits & { label: string; defaultValue?: number }> };

function projectChoice(
  command: Command | null,
  id: string,
  label: string,
  type: AgentChoice['type'],
  card?: AgentChoice['card'],
): AgentChoice {
  return { id, label, type, ...(card ? { card } : {}), command };
}

/** Derive the choices from the live UI interaction, including server-driven picker panels. */
export function projectedChoices(state: GameSessionState, promptId: string) {
  const { view, prompt, interaction } = state;
  if (!view || !prompt || interaction.prompt !== prompt || state.awaitingServer || state.resyncing || state.stalled) return null;

  const playerNames = new Map((view.players ?? []).map((player) => [player.playerId, player.name]));
  const pregame = pregameChoice(prompt, {
    pregame: !view.step,
    clickable: interaction.clickable.keys(),
    handIds: new Set(Object.keys(view.myHand ?? {})),
    playerIds: new Set(playerNames.keys()),
  });
  const visible = { ...view.myHand, ...view.stack, ...(prompt.kind === 'target' ? prompt.cards : undefined) };
  for (const player of view.players ?? []) Object.assign(visible, player.battlefield, player.graveyard, player.exile);
  const visibleSourceId = (id: unknown) => {
    if (typeof id !== 'string') return undefined;
    const source = visible[id] ?? Object.values(view.stack ?? {}).find((card) => card.cardId === id);
    return source && !source.faceDown && !source.hideInfo ? id : undefined;
  };
  const sourceObjectId = prompt.kind === 'chooseAbility' ? visibleSourceId(prompt.sourceObjectId)
    : prompt.kind === 'ask' ? visibleSourceId(prompt.options.abilitySourceId) : undefined;
  const targetSourceId = prompt.kind === 'target' ? visibleSourceId(prompt.options.targetSourceId) : undefined;
  const paymentSourceId = prompt.kind === 'playMana' ? visibleSourceId(prompt.options.paymentSourceId) : undefined;
  const targetZone = prompt.kind === 'target' && typeof prompt.options.targetZone === 'string' ? prompt.options.targetZone : undefined;
  const targetRole = targetSourceId && typeof prompt.options.targetRole === 'number' ? prompt.options.targetRole : undefined;

  const buttons = [interaction.mainButton, ...interaction.secondaryButtons].filter((button) => button !== null);
  const choices = buttons.map((button, index) => {
    if (prompt.kind === 'priority' && button.command.type === 'boolean' && !button.command.value) {
      return projectChoice(button.command, 'pass', 'Pass', 'pass');
    }
    const choice = projectChoice(button.command, `button-${index}`, button.label, 'button');
    if (interaction.mode === 'question' && button.command.type === 'boolean') choice.answer = button.command.value;
    if (targetSourceId && targetRole !== undefined && prompt.kind === 'target' && prompt.chosen.length
      && button === interaction.mainButton && button.command.type === 'uuid' && button.command.id === null) {
      choice.intent = 'confirm_targets';
    }
    if (interaction.mode === 'declareAttackers') {
      if (button.command.type === 'string' && button.command.value === 'special') choice.intent = 'attack_all';
      else if (button.command.type === 'boolean' && button.command.value) choice.intent = 'confirm_attack';
    }
    if (interaction.mode === 'declareBlockers' && button.command.type === 'boolean' && button.command.value) {
      choice.intent = 'confirm_block';
    }
    return choice;
  });
  const triggerOrder = isTriggerOrderPrompt(prompt);
  for (const [id, command] of interaction.clickable) {
    const card = visible[id] ? cardOnBoard(visible[id], id) : undefined;
    const legal = view.canPlayObjects?.objects?.[id];
    const other = legal?.other ?? [];
    const manaAbilities = [...(legal?.basicManaAbilities ?? []), ...other.filter((ability) => ability.abilityType === 'ACTIVATED_MANA')];
    const manaOnly = prompt.kind === 'priority' && !!manaAbilities.length && !legal?.basicCastAbilities?.length
      && !legal?.basicPlayAbilities?.length && other.every((ability) => ability.abilityType === 'ACTIVATED_MANA');
    const visibleMana = card && !card.faceDown ? manaAbilities.flatMap((ability) => {
      if (!ability.id) return [];
      const manaColors = colorSymbols(ability.manaColors);
      return [{ abilityId: ability.id, ...(manaColors ? { manaColors } : {}) }];
    }) : [];
    const visibleSpells = card && !card.faceDown
      ? [...(legal?.basicCastAbilities ?? []), ...other.filter((ability) => ability.abilityType === 'SPELL')]
        .flatMap((ability) => ability.id ? [{ abilityId: ability.id, ...(ability.value ? { label: stripMarkup(ability.value) } : {}) }] : [])
      : [];
    const visibleActivations = prompt.kind === 'priority' && card && !card.faceDown
      && view.players?.some((player) => player.playerId === state.playerId && !!player.battlefield?.[id])
      ? other.flatMap((ability) => ability.abilityType === 'ACTIVATED_NONMANA' && ability.id
        ? [{ abilityId: ability.id, ...(ability.value ? { label: stripMarkup(ability.value) } : {}) }] : [])
        .map((ability, _, abilities) => {
          const abilityText = publicActivationText(card, ability.label, abilities);
          return abilityText ? { ...ability, abilityText } : ability;
        }) : [];
    const plainMana = manaOnly && manaAbilities.every((ability) => typeof ability.plainMana === 'boolean')
      ? manaAbilities.every((ability) => ability.plainMana) : undefined;
    let label = pregame === 'startingPlayer' ? id === state.playerId ? 'Play first' : 'Draw first'
      : card?.name ?? playerNames.get(id) ?? 'Choose object';
    const trigger = triggerOrder ? prompt.cards?.[id] as StackAbilityView | undefined : undefined;
    const sourceId = trigger?.sourceCard?.id;
    const source = sourceId ? (view.players ?? []).map((player) => player.battlefield?.[sourceId]).find(Boolean) : undefined;
    const triggerSourceId = source && !source.faceDown && !source.hideInfo ? sourceId : undefined;
    if (triggerSourceId && trigger?.rules?.[0]) {
      label = `${source?.name ?? source?.displayName ?? label} — ${stripMarkup(trigger.rules[0])}`;
    }
    const canPlayLand = prompt.kind === 'priority' && !card?.faceDown && !!legal?.basicPlayAbilities?.length;
    choices.push({ ...projectChoice(command, `object-${id}`, label, manaOnly ? 'manaAbility' : 'object', card), objectId: id,
      ...(canPlayLand ? { canPlayLand: true } : {}),
      ...(visibleMana.length ? { manaAbilities: visibleMana } : {}),
      ...(visibleSpells.length ? { spellAbilities: visibleSpells } : {}),
      ...(visibleActivations.length ? { nonManaAbilities: visibleActivations } : {}),
      ...(plainMana !== undefined ? { plainMana } : {}),
      ...(triggerSourceId ? { triggerSourceId } : {}),
    });
  }

  const details: { amount?: Limits; amounts?: Amounts } = {};
  switch (prompt.kind) {
    case 'chooseAbility':
      prompt.choices.forEach(({ id, text, abilityType, spellName, manaColors }, index) => {
        const label = stripMarkup(text).replace(/^\d+\.\s*/, '') || `Ability ${index + 1}`;
        const symbols = colorSymbols(manaColors);
        choices.push({ ...projectChoice({ type: 'uuid', id }, `ability-${index}`, label, 'option'),
          ...(sourceObjectId ? { abilityId: id } : {}),
          ...(sourceObjectId && abilityType ? { abilityType } : {}),
          ...(sourceObjectId && symbols ? { manaColors: symbols } : {}),
          ...(sourceObjectId && abilityType === 'SPELL' && spellName ? { spellName } : {}),
        });
      });
      choices.push(projectChoice({ type: 'uuid', id: null }, 'cancel', 'Cancel', 'button'));
      break;
    case 'chooseChoice': {
      const keys = Object.entries(prompt.choice.keyChoices ?? {});
      const options = keys.length ? keys : (prompt.choice.choices ?? []).map((label) => [label, label]);
      options.forEach(([value, label], index) => {
        choices.push(projectChoice({ type: 'string', value }, `option-${index}`, stripMarkup(label), 'option'));
      });
      if (!prompt.choice.required) choices.push(projectChoice({ type: 'string', value: '' }, 'skip', 'Skip', 'button'));
      break;
    }
    case 'choosePile':
      for (const [index, pile] of [prompt.pile1, prompt.pile2].entries()) {
        const choice = projectChoice({ type: 'boolean', value: index === 0 }, `pile-${index + 1}`, `Choose pile ${index + 1}`, 'pile');
        choice.cards = pile.map((card) => cardOnBoard(card, card.id));
        choices.push(choice);
      }
      break;
    case 'amount':
      details.amount = { min: prompt.min, max: prompt.max };
      choices.push(projectChoice(null, 'amount', 'Submit an integer within the provided range', 'number'));
      break;
    case 'multiAmount':
      details.amounts = {
        min: prompt.min,
        max: prompt.max,
        items: prompt.items.map((item) => ({
          label: stripMarkup(item.message), min: item.min ?? 0, max: item.max, defaultValue: item.defaultValue,
        })),
      };
      choices.push(projectChoice(null, 'amounts', 'Submit one integer per provided item in order', 'numbers'));
      if (prompt.canCancel && !choices.some((choice) => choice.command?.type === 'string' && choice.command.value === '')) {
        choices.push(projectChoice({ type: 'string', value: '' }, 'cancel', 'Cancel', 'button'));
      }
      break;
  }
  const informationBoundary = prompt.kind === 'target' && prompt.options.targetZone === 'LIBRARY' ? 'library_choice'
    : prompt.kind === 'choosePile' ? 'revealed_piles'
      : /^(?:Choose which flip to keep|Choose which die roll result to keep|Re-roll\b)/i.test(prompt.text) ? 'random_result' : null;
  return { id: promptId, kind: pregame ?? interaction.mode, instruction: stripMarkup(interaction.headline), choices,
    ...(triggerOrder ? { triggerOrder: true } : {}),
    ...(sourceObjectId ? { sourceObjectId } : {}),
    ...(sourceObjectId && prompt.kind === 'chooseAbility' && prompt.modePicker ? { modePicker: true } : {}),
    ...(paymentSourceId ? { paymentSourceId } : {}),
    ...(targetZone ? { targetZone } : {}),
    ...(targetSourceId ? { targetSourceId } : {}),
    ...(targetRole !== undefined && prompt.kind === 'target' ? { targetRole, chosenTargetIds: prompt.chosen } : {}),
    ...(informationBoundary ? { informationBoundary } : {}), ...details };
}

type AgentDecision = NonNullable<ReturnType<typeof projectedChoices>>;

/** The tool only needs metadata and choice IDs. Commands stay inside the seat implementation. */
export function describeAgentDecision(decision: AgentDecision | null) {
  return decision && {
    ...decision,
    choices: decision.choices.map(({ id, label, type, card, cards, objectId, intent, canPlayLand, abilityType, spellName, triggerSourceId, abilityId, manaColors, manaAbilities, spellAbilities, nonManaAbilities, plainMana, answer }) => ({
      id, label, type, ...(card ? { card } : {}), ...(cards ? { cards } : {}), ...(objectId ? { objectId } : {}), ...(intent ? { intent } : {}),
      ...(canPlayLand ? { canPlayLand } : {}),
      ...(abilityType ? { abilityType } : {}),
      ...(abilityId ? { abilityId } : {}),
      ...(manaColors ? { manaColors } : {}),
      ...(manaAbilities ? { manaAbilities } : {}),
      ...(spellAbilities ? { spellAbilities } : {}),
      ...(nonManaAbilities ? { nonManaAbilities } : {}),
      ...(plainMana !== undefined ? { plainMana } : {}),
      ...(answer !== undefined ? { answer } : {}),
      ...(spellName ? { spellName } : {}),
      ...(triggerSourceId ? { triggerSourceId } : {}),
    })),
  };
}

export function commandForAgentChoice(choice: AgentChoice, decision: AgentDecision, value: unknown): Command | null {
  if (choice.command) return choice.command;
  function within(n: unknown, limits: Limits): n is number {
    return typeof n === 'number' && Number.isSafeInteger(n) && n >= (limits.min ?? 0) && n <= (limits.max ?? Infinity);
  }
  if (choice.type === 'number' && decision.amount && within(value, decision.amount)) return { type: 'integer', value };
  if (choice.type === 'numbers' && decision.amounts && Array.isArray(value)) {
    const { items } = decision.amounts;
    if (value.length === items.length && value.every((amount, index) => within(amount, items[index]))
      && within(value.reduce((total, amount) => total + amount, 0), decision.amounts)) {
      return { type: 'string', value: value.join(' ') };
    }
  }
  return null;
}
