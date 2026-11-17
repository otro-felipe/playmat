import type { CardView, PermanentView, StackAbilityView } from '../../protocol/generated/views';
import type { GameSessionState } from './gameSession';
import type { Command } from './interaction';
import { pregameChoice } from './pregame';
import { stripMarkup } from './prompt';

/** An allowlisted view of a card for both MCP transports. Face-down cards keep their public object ID. */
function cardOnBoard(card: CardView, id: string | undefined) {
  const { tapped, damage } = card as PermanentView;
  if (card.faceDown || card.hideInfo) return { id, faceDown: true, name: 'Face-down card', tapped: !!tapped };
  return {
    id,
    cardId: card.cardId,
    name: card.name ?? card.displayName ?? 'Unnamed card',
    controllerId: card.controllerId,
    ...(card.abilityType === 'TRIGGERED_NONMANA' || card.abilityType === 'TRIGGERED_MANA' ? {
      abilityType: card.abilityType,
      sourceId: (card as StackAbilityView).sourceCard?.id,
      abilityText: card.rules?.[0] ? stripMarkup(card.rules[0]) : undefined,
    } : {}),
    types: card.cardTypes ?? [],
    rules: card.rules?.map(stripMarkup),
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

function cardsOnBoard(cards: Record<string, CardView> | undefined) {
  return Object.entries(cards ?? {}).flatMap(([id, card]) => card ? [cardOnBoard(card, id)] : []);
}

/** The game state visible to the authenticated seat, with public counts for every other hand. */
export function visibleAgentGame(state: GameSessionState | undefined) {
  const view = state?.view;
  return {
    turn: view?.turn ?? null,
    phase: view?.phase ?? null,
    step: view?.step ?? null,
    activePlayer: view?.activePlayerName ?? null,
    priorityPlayer: view?.priorityPlayerName ?? null,
    ownHand: cardsOnBoard(view?.myHand),
    stack: cardsOnBoard(view?.stack),
    players: (view?.players ?? []).map((player) => ({
      id: player.playerId,
      name: player.name,
      yourSeat: player.playerId === state?.playerId,
      life: player.life,
      handCount: player.handCount,
      libraryCount: player.libraryCount,
      wins: player.wins,
      battlefield: cardsOnBoard(player.battlefield),
      graveyard: cardsOnBoard(player.graveyard),
      exile: cardsOnBoard(player.exile),
      manaPool: player.playerId === state?.playerId ? player.manaPool : undefined,
    })),
    combat: (view?.combat ?? []).map((group) => ({
      attackers: cardsOnBoard(group.attackers),
      blockers: cardsOnBoard(group.blockers),
    })),
  };
}

interface AgentChoice {
  id: string;
  label: string;
  type: 'pass' | 'button' | 'manaAbility' | 'object' | 'option' | 'pile' | 'number' | 'numbers';
  command: Command | null;
  card?: ReturnType<typeof cardOnBoard>;
  cards?: ReturnType<typeof cardOnBoard>[];
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

  const buttons = [interaction.mainButton, ...interaction.secondaryButtons].filter((button) => button !== null);
  const choices = buttons.map((button, index) => {
    if (prompt.kind === 'priority' && button.command.type === 'boolean' && !button.command.value) {
      return projectChoice(button.command, 'pass', 'Pass', 'pass');
    }
    return projectChoice(button.command, `button-${index}`, button.label, 'button');
  });
  for (const [id, command] of interaction.clickable) {
    const card = visible[id] ? cardOnBoard(visible[id], id) : undefined;
    const legal = view.canPlayObjects?.objects?.[id];
    const manaOnly = prompt.kind === 'priority' && !!legal?.basicManaAbilities?.length
      && !legal?.basicCastAbilities?.length && !legal?.basicPlayAbilities?.length && !legal?.other?.length;
    const label = pregame === 'startingPlayer' ? id === state.playerId ? 'Play first' : 'Draw first'
      : card?.name ?? playerNames.get(id) ?? 'Choose object';
    choices.push(projectChoice(command, `object-${id}`, label, manaOnly ? 'manaAbility' : 'object', card));
  }

  const details: { amount?: Limits; amounts?: Amounts } = {};
  switch (prompt.kind) {
    case 'chooseAbility':
      prompt.choices.forEach(({ id, text }, index) => {
        const label = stripMarkup(text).replace(/^\d+\.\s*/, '') || `Ability ${index + 1}`;
        choices.push(projectChoice({ type: 'uuid', id }, `ability-${index}`, label, 'option'));
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
  return { id: promptId, kind: pregame ?? interaction.mode, instruction: stripMarkup(interaction.headline), choices, ...details };
}

type AgentDecision = NonNullable<ReturnType<typeof projectedChoices>>;

/** The tool only needs metadata and choice IDs. Commands stay inside the seat implementation. */
export function describeAgentDecision(decision: AgentDecision | null) {
  return decision && {
    ...decision,
    choices: decision.choices.map(({ id, label, type, card, cards }) => ({
      id, label, type, ...(card ? { card } : {}), ...(cards ? { cards } : {}),
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
