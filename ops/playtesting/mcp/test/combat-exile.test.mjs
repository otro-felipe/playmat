import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GameSeat } from '../src/game-seat.mjs';
import { visibleAgentGame } from '../dist/engine-core.mjs';

const creature = (id, name, controllerId, power, toughness) => ({
  id, cardId: id + '-card', name, controllerId, power: String(power), toughness: String(toughness),
  damage: 0, types: ['CREATURE'],
});
const inZone = (card, name = card.name) => ({ id: card.cardId, cardId: card.cardId, name, types: card.types });
const priority = (id) => ({ id, kind: 'priority', choices: [{ id: 'pass', type: 'pass' }] });

for (const variant of ['attacker', 'blocker', 'rest-in-peace', 'split-frames', 'no-witness', 'stale-witness', 'same-name',
  'nonlethal', 'preexisting', 'two-zones', 'wrong-owner', 'face-down', 'wrong-destination', 'wrong-life', 'defender-wrong-life', 'defender-no-player-hit',
  'opponent-response', 'new-information', 'unplanned-choice']) {
  test('[PM-LINE-COMBAT-EXILE] reconciles a witnessed lethal replacement and preserves the tail: ' + variant, async (t) => {
    const defending = variant === 'blocker' || variant.startsWith('defender-');
    const rest = variant === 'rest-in-peace';
    const striker = creature('striker', rest ? "Nylea's Forerunner" : 'Etching of Kumano', 'me', 5, 3);
    const victim = creature('victim', defending ? 'Sheoldred, the Apocalypse' : 'Graveyard Trespasser', 'rival',
      defending ? 4 : 3, defending ? 5 : 3);
    const support = creature('support', defending ? 'Monastery Swiftspear' : 'Screaming Nemesis', 'me', defending ? 2 : 3, 3);
    const glutton = creature('glutton', 'Graveyard Glutton', 'rival', 4, 4);
    const unblocked = creature('unblocked-glutton', 'Graveyard Glutton', 'rival', 4, 4);
    const enchantment = { id: 'rip', cardId: 'rip-card', name: 'Rest in Peace', controllerId: 'me', types: ['ENCHANTMENT'] };
    const pilot = { id: 'me', yourSeat: true, life: defending ? 9 : 19, graveyard: [], exile: [], battlefield: [striker, support, ...(rest ? [enchantment] : [])] };
    const rival = { id: 'rival', life: defending ? 8 : 18, graveyard: [], exile: variant === 'preexisting' ? [inZone(victim)] : [],
      battlefield: defending ? [victim, glutton, unblocked] : [victim] };
    const victimCard = inZone(victim);
    const strikerCard = inZone(striker, rest ? striker.name : 'Kumano Faces Kakkazan');
    const baseline = { epoch: 'combat-exile', publicActions: { me: 0, rival: 0 }, resolutions: {},
      resolutionRevision: 0, informationRevision: 0, combatDamage: [], combatRevision: 0, combatExileReplacements: {} };
    const combat = defending ? [
      { defenderId: pilot.id, isBlocked: true, attackers: [victim], blockers: [striker] },
      { defenderId: pilot.id, isBlocked: true, attackers: [glutton], blockers: [support] },
      { defenderId: pilot.id, isBlocked: false, attackers: [unblocked], blockers: [] },
    ] : [
      { defenderId: rival.id, isBlocked: true, attackers: [striker], blockers: [victim] },
      { defenderId: rival.id, isBlocked: false, attackers: [support], blockers: [] },
    ];
    let state = { gameId: 'combat', status: 'active', epoch: 1, cursor: 1, turn: defending ? 18 : 7,
      activePlayerId: defending ? rival.id : pilot.id, step: 'DECLARE_BLOCKERS', priority: 'self', ownHand: [],
      stack: [], players: [pilot, rival], combat, decision: priority('blocks'), sequenceEvidence: baseline };
    const applied = [], listeners = new Set();
    const update = (change) => {
      state = { ...state, ...change, cursor: state.cursor + 1 };
      for (const listener of [...listeners]) listener();
    };
    const seat = new GameSeat({ snapshot: () => state, subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }, respond: async (id) => {
      applied.push(id);
      if (id === 'postcombat') {
        update({ step: 'END_TURN', decision: priority('end') });
        return { submitted: true };
      }
      assert.equal(id, 'blocks');
      const hits = [];
      const hit = (source, target, amount) => hits.push({ revision: hits.length + 1, sourceId: source.id,
        controllerId: source.controllerId, targetId: target.id, amount, ...(target.types ? { targetPermanent: true } : {}) });
      hit(striker, victim, variant === 'nonlethal' ? 1 : Number(victim.toughness));
      hit(victim, striker, Number(victim.power));
      if (defending) {
        hit(glutton, support, 4);
        hit(support, glutton, Number(support.power));
        if (variant !== 'defender-no-player-hit') hit(unblocked, pilot, 4);
      } else {
        hit(striker, rival, 2);
        hit(support, rival, 3);
      }
      const combatExileReplacements = variant === 'no-witness' ? {} : { [victim.id]: variant === 'stale-witness' ? 0 : 1 };
      if (rest) combatExileReplacements[striker.id] = 2;
      const pilotAfter = { ...pilot, life: defending ? variant === 'defender-wrong-life' ? 6 : 5 : 19,
        battlefield: pilot.battlefield.filter(card => card !== striker && (!defending || card !== support)),
        graveyard: rest ? [] : [strikerCard, ...(defending ? [inZone(support)] : [])],
        exile: rest ? [strikerCard] : variant === 'wrong-owner' ? [victimCard] : [] };
      const rivalAfter = { ...rival, life: defending ? 8 : variant === 'wrong-life' ? 14 : 13,
        battlefield: defending ? [{ ...glutton, damage: Number(support.power) }, unblocked] : [],
        graveyard: variant === 'two-zones' || variant === 'wrong-destination' ? [victimCard] : [],
        exile: variant === 'wrong-owner' || variant === 'wrong-destination' ? [] : [variant === 'same-name'
          ? { ...victimCard, id: 'other', cardId: 'other' } : variant === 'face-down' ? { id: victim.cardId, faceDown: true } : victimCard] };
      if (variant === 'split-frames') {
        const damagedStriker = { ...striker, damage: 3 }, damagedVictim = { ...victim, damage: 3 };
        update({ step: 'COMBAT_DAMAGE', decision: null, players: [
          { ...pilot, battlefield: [damagedStriker, support] }, { ...rival, life: 13, battlefield: [damagedVictim] },
        ], combat: [{ ...combat[0], attackers: [damagedStriker], blockers: [damagedVictim] }, combat[1]],
        sequenceEvidence: { ...baseline, combatRevision: hits.length, combatDamage: hits } });
      }
      update({ step: 'POSTCOMBAT_MAIN', combat: [], players: [pilotAfter, rivalAfter],
        decision: variant === 'unplanned-choice' ? { id: 'which', kind: 'target', choices: [{ id: 'unknown' }] } : priority('postcombat'),
        sequenceEvidence: { ...baseline, combatRevision: hits.length, combatDamage: hits, combatExileReplacements,
          publicActions: { me: 0, rival: Number(variant === 'opponent-response') }, informationRevision: Number(variant === 'new-information') } });
      return { submitted: true };
    } });
    t.after(() => seat.invalidate());
    const started = seat.startTurn({ gameId: 'combat', cursor: 1, finish: 'none', settle: false,
      actions: [{ kind: 'pass_until', destination: 'end_step', policy: 'if_no_play' }] }, async () => true);
    const receipt = await seat.waitSequenceStatus({ gameId: 'combat', sequenceId: started.sequenceId }, 2500);
    const completed = ['attacker', 'blocker', 'rest-in-peace', 'split-frames'].includes(variant);
    assert.equal(receipt.status, completed ? 'completed' : 'interrupted', receipt.error?.message);
    assert.deepEqual(applied, completed ? ['blocks', 'postcombat'] : ['blocks']);
    if (!completed) {
      const reason = { 'opponent-response': 'opponent_action', 'new-information': 'new_information', 'unplanned-choice': 'response_available' }[variant];
      assert.equal(receipt.reason, reason ?? 'opponent_state_changed', receipt.error?.message);
    }
  });
}

test('[PM-LINE-COMBAT-EXILE] the seat projects the public replacement witness', () => {
  const combatExileReplacements = { target: 2 };
  const projected = visibleAgentGame({ view: { sequenceEvidence: { combatExileReplacements } } });
  assert.deepEqual(projected.sequenceEvidence.combatExileReplacements, combatExileReplacements);
});
