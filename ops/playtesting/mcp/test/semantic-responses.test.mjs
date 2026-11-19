import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { GameSeat } from '../src/game-seat.mjs';

const bird = { id: 'bird', cardId: 'bird', name: 'Slickshot Show-Off', types: ['CREATURE'] };
const talent = { id: 'talent', cardId: 'talent', name: "Stormchaser's Talent", types: ['ENCHANTMENT'] };
const pass = { id: 'pass', type: 'pass' };
const priority = (id, choice) => ({ id, kind: 'priority', choices: [pass, ...(choice ? [choice] : [])] });
const evidence = () => ({ epoch: 'response-test', publicActions: { me: 0, rival: 0 }, resolutions: {}, resolutionRevision: 0, informationRevision: 0, combatRevision: 0, combatDamage: [] });
async function plan(t, { initial = {}, actions, respond, finish = 'none', legacySteps }) {
  let state = { gameId: 'response', cursor: 1, epoch: 1, status: 'active', turn: 3, activePlayer: 'Pilot', activePlayerId: 'me', step: 'PRECOMBAT_MAIN', priority: 'self', stack: [], ownHand: [bird], players: [{ id: 'me', yourSeat: true, battlefield: [talent] }, { id: 'rival', life: 20, battlefield: [] }], sequenceEvidence: evidence(), decision: priority('play', { id: 'bird-choice', card: bird }), ...initial };
  const listeners = new Set(), applied = [];
  const update = (change) => { state = { ...state, ...change, cursor: state.cursor + 1 }; for (const fn of [...listeners]) fn(); };
  const seat = new GameSeat({ snapshot: () => state, subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, respond: async (id, choice, value) => { applied.push([id, choice, value]); await respond({ id, choice, value, state, update }); return { submitted: true }; } });
  t.after(() => seat.invalidate());
  const start = legacySteps ? seat.startSequence({ gameId:'response',cursor:1,steps:legacySteps },async()=>true) : seat.startTurn({ gameId: 'response', cursor: 1, actions, finish }, async () => true);
  for (let n=0;n<100;n++) { const result=seat.sequenceStatus({gameId:'response',sequenceId:start.sequenceId}); if(result.status!=='running') return {result,applied,state}; await sleep(2); }
  assert.fail('A deterministic response line must terminate');
}

test('[PM-AC-09-RESPONSES] an observed exact choice and numeric value have submit_decision parity', async (t) => {
  const { result, applied } = await plan(t, { initial: { decision: { id: 'amount', kind: 'amount', choices: [{ id: 'amount-choice', type: 'number' }] } }, actions: [{ kind: 'choose', decisionId: 'amount', choiceId: 'amount-choice', value: 2 }], respond: ({ update }) => update({ decision: priority('done') }) });
  assert.equal(result.status,'completed'); assert.deepEqual(applied,[['amount','amount-choice',2]]);
});

for (const plot of [false,true]) test(`[PM-AC-09-RESPONSES] Bird cast/plot picker is not mistaken for an unexpected stack change: ${plot}`, async (t) => {
  const { result, applied }=await plan(t,{actions:[{kind:'play',select:{cardId:'bird',zone:'hand'},expectCast:!plot},{kind:'choose',select:{label:plot?'Plot':'Cast'},guard:{kind:'chooseAbility',instruction:'Choose spell or ability'}},{kind:'choose',select:{label:'Pay'},guard:{kind:'payMana'}}],respond:({id,update,state})=>{
    if(id==='play')update({decision:{id:'menu',kind:'chooseAbility',instruction:'Choose spell or ability',choices:[{id:'plot',label:'Plot'},{id:'cast',label:'Cast'}]}});
    else if(id==='menu')update({ownHand:[],stack:plot?[]:[{...bird,id:'bird-stack',controllerId:'me'}],players:plot?[{...state.players[0],exile:[bird]},state.players[1]]:state.players,decision:{id:'pay',kind:'payMana',choices:[{id:'pay-choice',label:'Pay'}]}});
    else if(id==='pay')update({decision:priority('resolve')});
    else update({stack:[],sequenceEvidence:{...evidence(),resolutions:{'bird-stack':1},resolutionRevision:1},decision:priority('done')});
  }});
  assert.equal(result.status,'completed'); assert.equal(applied.length,plot?3:4);
});

for (const variant of ['pending', 'observed', 'wrong-source', 'wrong-type', 'wrong-face']) {
  test(`[PM-LINE-01] Room face, payment and resolution use the typed picker: ${variant}`, async (t) => {
    const room = { id: 'room-card', cardId: 'room-card', name: 'Unholy Annex // Ritual Chamber', types: ['ENCHANTMENT'] };
    const land = { id: 'swamp', name: 'Swamp', types: ['LAND'] };
    const face = { ...room, id: 'room-stack', name: variant === 'wrong-face' ? 'Ritual Chamber' : 'Unholy Annex', controllerId: 'me' };
    const instruction = 'Choose spell or ability to play Unholy Annex // Ritual Chamber';
    const panel = { id: 'room-panel', kind: 'panel', instruction,
      sourceObjectId: variant === 'wrong-source' ? 'different-card' : room.id,
      choices: [{ id: 'annex', label: 'Cast Unholy Annex', type: 'option',
        abilityType: variant === 'wrong-type' ? 'SPECIAL_ACTION' : 'SPELL', spellName: 'Unholy Annex' }] };
    const choice = variant === 'observed'
      ? { decisionId: panel.id, choiceId: 'annex' }
      : { guard: { kind: 'panel', instruction }, select: { label: 'Cast Unholy Annex' } };
    const { result, applied } = await plan(t, {
      initial: { ownHand: [room], players: [{ id: 'me', yourSeat: true, battlefield: [land] }, { id: 'rival', battlefield: [] }],
        decision: variant === 'observed' ? panel : priority('open-room', { id: 'room', card: room }) },
      actions: [
        ...(variant === 'observed' ? [] : [{ kind: 'play', select: { cardId: room.id, zone: 'hand' } }]),
        { kind: 'choose', ...choice, expectCast: true },
        { kind: 'choose', guard: { kind: 'payMana' }, select: { objectId: land.id, zone: 'battlefield' } },
      ],
      respond: ({ id, update }) => {
        if (id === 'open-room') return update({ decision: panel });
        if (id === 'room-panel') return update({ ownHand: [], stack: [face],
          decision: { id: 'room-pay', kind: 'payMana', choices: [{ id: 'tap', objectId: land.id, card: land }] } });
        if (id === 'room-pay') return update({ decision: priority('room-resolve') });
        if (id === 'room-resolve') return update({ stack: [], decision: priority('done'),
          sequenceEvidence: { ...evidence(), resolutions: { [face.id]: 1 }, resolutionRevision: 1 } });
        assert.fail(`Unexpected room decision ${id}`);
      },
    });
    assert.equal(result.reason, { 'wrong-source': 'bad_cast_expectation', 'wrong-type': 'bad_cast_expectation',
      'wrong-face': 'state_changed' }[variant] ?? null, JSON.stringify(result));
    const expected = {
      pending: ['room', 'annex', 'tap', 'pass'], observed: ['annex', 'tap', 'pass'],
      'wrong-source': ['room'], 'wrong-type': ['room'], 'wrong-face': ['room', 'annex'],
    };
    assert.deepEqual(applied.map(([, answer]) => answer), expected[variant]);
  });
}

for (const variant of ['own','rival','trigger','other-text']) test(`[PM-AC-09-RESPONSES] exact Class activation forecast keeps triggers and rival sources separate: ${variant}`,async(t)=>{
  const text='{3}{U}: Level 2';
  const {result,applied}=await plan(t,{initial:{decision:priority('level',{id:'level-choice',card:talent})},actions:[{kind:'choose',select:{cardId:'talent',zone:'battlefield'},guard:{kind:'priority'},expectAbility:{sourceId:variant==='rival'?'enemy':'talent',abilityText:text}}],respond:({id,update})=>{
    if(id==='level')update({stack:[{id:'level-stack',sourceId:'talent',controllerId:'me',abilityType:variant==='trigger'?'TRIGGERED_NONMANA':'ACTIVATED_NONMANA',abilityText:variant==='other-text'?'Other ability':text}],decision:priority('resolve-level')});
    else update({stack:[],sequenceEvidence:{...evidence(),resolutions:{'level-stack':1},resolutionRevision:1},decision:priority('done')});
  }});
  assert.equal(result.status,variant==='own'?'completed':'interrupted'); assert.equal(applied.length,variant==='own'?2:variant==='rival'?0:1);
});

for (const forecastAtPanel of [true, false]) test(`[PM-LINE-01] Fel ${forecastAtPanel ? 'casts, pays, activates from the projected panel and proceeds to combat' : 'can target and attack when the activation is forecast before the panel'}`, async (t) => {
  const fel = { id: 'fel', cardId: 'fel', name: 'Professor Dellian Fel', controllerId: 'me', types: ['PLANESWALKER'] };
  const felSpell = { ...fel, id: 'fel-spell' };
  const lands = ['Swamp', 'Forest', 'Swamp', 'Forest'].map((name, index) => ({ id: `land-${index}`, name, types: ['LAND'] }));
  const attacker = { id: 'own-attacker', name: 'Graveyard Glutton', controllerId: 'me', types: ['CREATURE'] };
  const target = { id: 'target-creature', name: 'Badgermole Cub', controllerId: 'rival', types: ['CREATURE'] };
  const abilityText = '-3: Destroy target creature.';
  const pickerInstruction = 'Choose spell or ability to play Professor Dellian Fel';
  const targetInstruction = 'Select a creature';
  const mode = { id: 'loyalty-option', label: abilityText, type: 'option', abilityType: 'ACTIVATED_NONMANA' };
  const ability = { id: 'fel-activation', sourceId: fel.id, controllerId: 'me', abilityType: 'ACTIVATED_NONMANA', abilityText };
  const expectAbility = { sourceId: fel.id, abilityText };
  const own = { id: 'me', yourSeat: true, battlefield: [...lands, attacker] };
  const ownWithFel = { ...own, battlefield: [...own.battlefield, fel] };
  const rival = { id: 'rival', life: 20, battlefield: [target] };
  const openFel = priority('open-fel', { id: 'open-loyalty', card: fel, objectId: fel.id });
  const selectFel = { objectId: fel.id, zone: 'battlefield' };
  const { result, applied, state } = await plan(t, {
    initial: forecastAtPanel
      ? { ownHand: [fel], players: [own, rival], decision: priority('cast-fel', { id: 'cast-choice', card: fel }) }
      : { ownHand: [], players: [ownWithFel, rival], decision: openFel },
    actions: [
      ...(forecastAtPanel ? [
        { kind: 'play', select: { cardId: fel.id, zone: 'hand' }, payWith: lands.map(({ id }) => id) },
        { kind: 'play', select: selectFel, expectCast: false },
      ] : [{ kind: 'choose', select: selectFel, guard: { kind: 'priority' }, expectAbility }]),
      { kind: 'choose', select: { label: mode.label }, guard: { kind: 'panel', instruction: pickerInstruction },
        ...(forecastAtPanel ? { expectAbility } : {}) },
      { kind: 'choose', select: { objectId: target.id }, guard: { kind: 'target', instruction: targetInstruction } },
      { kind: 'attack', attackers: [attacker.id] },
    ],
    respond: ({ id, choice, update, state }) => {
      const payment = (index) => ({ id: `pay-${index}`, kind: 'payMana', choices: lands.slice(index)
        .map((card) => ({ id: `tap-${card.id}`, objectId: card.id, card, type: 'manaAbility' })) });
      if (id === 'cast-fel') return update({ ownHand: [], stack: [felSpell], decision: payment(0) });
      if (id.startsWith('pay-')) {
        const index = Number(id.slice('pay-'.length));
        assert.equal(choice, `tap-${lands[index].id}`);
        return update({ decision: index + 1 < lands.length ? payment(index + 1) : priority('resolve-fel') });
      }
      if (id === 'resolve-fel') return update({ stack: [], players: [ownWithFel, rival],
        sequenceEvidence: { ...evidence(), resolutions: { [felSpell.id]: 1 }, resolutionRevision: 1 },
        decision: openFel });
      if (id === 'open-fel') return update({ decision: { id: 'loyalty-panel', kind: 'panel', instruction: pickerInstruction, sourceObjectId: fel.id,
        choices: [{ id: 'gain', label: '+2: You gain 3 life.' }, mode] } });
      if (id === 'loyalty-panel') return update({ stack: [ability], decision: { id: 'choose-target', kind: 'target',
        instruction: targetInstruction, choices: [{ id: 'target-choice', card: target, objectId: target.id }] } });
      if (id === 'choose-target') return update({ stack: [{ ...ability, targets: [target.id] }], decision: priority('resolve-loyalty') });
      if (id === 'resolve-loyalty') {
        const prior = state.sequenceEvidence;
        const revision = prior.resolutionRevision + 1;
        return update({ stack: [], players: [state.players[0], { ...rival, battlefield: [], graveyard: [target] }],
          sequenceEvidence: { ...prior, resolutions: { ...prior.resolutions, [ability.id]: revision }, resolutionRevision: revision },
          decision: priority('begin-combat') });
      }
      if (id === 'begin-combat') return update({ step: 'DECLARE_ATTACKERS', decision: { id: 'choose-attacker', kind: 'declareAttackers',
        choices: [{ id: 'attack-choice', card: attacker, objectId: attacker.id }] } });
      if (id === 'choose-attacker') return update({ combat: [{ attackers: [attacker], blockers: [] }],
        decision: { id: 'confirm-attack', kind: 'declareAttackers', choices: [{ id: 'confirm', intent: 'confirm_attack' }] } });
      if (id === 'confirm-attack') return update({ decision: priority('after-attack') });
      assert.fail(`Unexpected action ${id}`);
    },
  });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const cast = forecastAtPanel ? ['cast-choice', ...lands.map(({ id }) => `tap-${id}`), 'pass'] : [];
  assert.deepEqual(applied.map(([, choice]) => choice), [...cast, 'open-loyalty', mode.id, 'target-choice', 'pass', 'pass', 'attack-choice', 'confirm']);
  assert.deepEqual(state.players[1].graveyard, [target]);
  assert.equal(state.combat[0].attackers[0].id, attacker.id);
});

for(const boundary of ['library_choice','revealed_piles','random_result']) test(`[PM-AC-09-RESPONSES] a future ${boundary} blocks predecisions even when the card ID was already known`,async(t)=>{
  const {result,applied}=await plan(t,{actions:[{kind:'choose',choiceId:'bird-choice',guard:{kind:'priority'}},{kind:'choose',choiceId:'bottom',guard:{kind:'target',instruction:'Scry'}}],respond:({update})=>update({decision:{id:'scry',kind:'target',instruction:'Scry',informationBoundary:boundary,choices:[{id:'bottom',card:bird}]}})});
  assert.equal(result.reason,'new_information'); assert.equal(applied.length,1);
  assert.equal(result.error.actionIndex,0); assert.equal(result.error.code,'new_information');
});

test('[PM-AC-09-RESPONSES] a fresh plan may answer an already observed library choice',async(t)=>{
  const {result,applied}=await plan(t,{initial:{decision:{id:'scry',kind:'target',instruction:'Scry',informationBoundary:'library_choice',choices:[{id:'bottom',card:bird}]}},actions:[{kind:'choose',decisionId:'scry',choiceId:'bottom'}],respond:({update})=>update({decision:priority('done')})});
  assert.equal(result.status,'completed'); assert.equal(applied.length,1);
});

test('[PM-AC-09-RESPONSES] guard failures report the semantic action and actual prompt without replaying an accepted action',async(t)=>{
  const {result,applied}=await plan(t,{actions:[{kind:'choose',choiceId:'bird-choice',guard:{kind:'priority'}},{kind:'choose',select:{label:'Known mode'},guard:{kind:'chooseAbility',instruction:'Choose ability'}}],respond:({update})=>update({decision:{id:'discard',kind:'target',instruction:'Select a card (discard cost)',choices:[{id:'discard-card',card:bird}]}})});
  assert.equal(result.status,'interrupted'); assert.equal(applied.length,1); assert.equal(result.error.actionIndex,1); assert.equal(result.error.actualDecisionKind,'target'); assert.equal(result.error.expectedDecisionKind,'chooseAbility'); assert.match(result.error.message,/mandatory|intention/);
});

test('[PM-AC-09-RESPONSES] legacy resolution automation fails closed without information evidence',async(t)=>{
  const state={gameId:'legacy',cursor:1,epoch:1,status:'active',turn:3,activePlayer:'Pilot',activePlayerId:'me',priority:'self',ownHand:[],stack:[{...bird,id:'s',controllerId:'me'}],players:[{id:'me',yourSeat:true}],sequenceEvidence:{...evidence(),informationRevision:undefined},decision:priority('pass')};
  const seat=new GameSeat({snapshot:()=>state,subscribe:()=>()=>{},respond:()=>assert.fail('Missing evidence must stop before any answer')});
  t.after(()=>seat.invalidate());
  const started=seat.startSequence({gameId:'legacy',cursor:1,expectedStackIds:['s'],steps:[{kind:'pass_until',stackEmpty:true,allowPlannedResolutions:true}]},async()=>true);
  await sleep(2);
  assert.equal(seat.sequenceStatus({gameId:'legacy',sequenceId:started.sequenceId}).reason,'evidence_unavailable');
});

for(const rules of [['Scry 1. Draw a card.'],['Return a creature card at random from your graveyard to the battlefield.'],['Target opponent sacrifices a creature.']]) test(`[PM-AC-09-RESPONSES] preflight rejects a new intention after a selected uncertain spell: ${rules[0]}`,async(t)=>{
  const opt={id:'opt',cardId:'opt',name:'Information spell',types:['INSTANT'],rules};
  await assert.rejects(plan(t,{initial:{ownHand:[opt,bird],decision:priority('opt',{id:'opt-choice',card:opt})},actions:[{kind:'play',select:{cardId:'opt'}},{kind:'play',select:{cardId:'bird'}}],respond:()=>assert.fail('Preflight must reject before the cast')}),{code:'reevaluation_required'});
});

test('[PM-AC-09-RESPONSES] a generic random result among already known IDs still ends the declared intention',async(t)=>{
  const spell={id:'random',cardId:'random',name:'Random return',types:['SORCERY'],rules:['Return a creature card at random from your graveyard to the battlefield.']};
  const known={id:'known',cardId:'known',name:'Known creature',types:['CREATURE']};
  const {result,applied}=await plan(t,{initial:{ownHand:[spell],players:[{id:'me',yourSeat:true,battlefield:[talent],graveyard:[known]},{id:'rival',life:20}],decision:priority('random',{id:'random-choice',card:spell})},actions:[{kind:'play',select:{cardId:'random'}}],finish:'next_turn',respond:({id,update,state})=>{
    if(id==='random')update({ownHand:[],stack:[{...spell,id:'random-stack',controllerId:'me'}],decision:priority('resolve')});
    else if(id==='resolve')update({stack:[],players:[{...state.players[0],graveyard:[],battlefield:[talent,known]},state.players[1]],sequenceEvidence:{...evidence(),resolutions:{'random-stack':1},resolutionRevision:1},decision:priority('done')});
    else assert.fail('No automatic advance after an uncertain result');
  }});
  assert.equal(result.reason,'reevaluation_required');assert.equal(applied.length,2);
});

test('[PM-AC-09-RESPONSES] unrelated draw text on a permanent does not block its exact deterministic activation',async(t)=>{
  const source={...talent,rules:['{T}: Draw a card.','{1}: Add a lore counter.']};
  const {result}=await plan(t,{initial:{players:[{id:'me',yourSeat:true,battlefield:[source]},{id:'rival',life:20}],decision:priority('activate',{id:'activate-choice',card:source})},actions:[{kind:'choose',choiceId:'activate-choice',guard:{kind:'priority'},expectAbility:{sourceId:'talent',abilityText:'{1}: Add a lore counter.'}}],respond:({id,update})=>id==='activate'?update({stack:[{id:'ability',sourceId:'talent',controllerId:'me',abilityType:'ACTIVATED_NONMANA',abilityText:'{1}: Add a lore counter.'}],decision:priority('resolve')}):update({stack:[],sequenceEvidence:{...evidence(),resolutions:{ability:1},resolutionRevision:1},decision:priority('done')})});
  assert.equal(result.status,'completed');
});

test('[PM-AC-09-RESPONSES] both Reckless Rage target roles, payment and the exact Ward discard execute in one semantic line',async(t)=>{
  const rage={id:'rage',cardId:'rage',name:'Reckless Rage',types:['INSTANT'],rules:['Deal 4 damage to target creature you do not control and 2 damage to target creature you control.']};
  const otter={id:'otter',cardId:'otter',name:'Otter',types:['CREATURE']}, enemy={id:'enemy',cardId:'enemy',name:'Graveyard Trespasser',types:['CREATURE'],rules:['Ward—Discard a card.']}, land={id:'mana',cardId:'mana',name:'Mountain',types:['LAND']}, discard={id:'discard',cardId:'discard',name:'Mountain',types:['LAND']};
  const stack=(targets)=>({...rage,id:'rage-stack',controllerId:'me',targets});
  const ward={id:'ward',sourceId:'enemy',controllerId:'rival',abilityType:'TRIGGERED_NONMANA',abilityText:'Ward—Discard a card.'};
  const {result,applied}=await plan(t,{initial:{ownHand:[rage,discard],players:[{id:'me',yourSeat:true,battlefield:[otter,land]},{id:'rival',life:20,battlefield:[enemy]}],decision:priority('cast',{id:'rage-choice',card:rage})},actions:[
    {kind:'play',select:{cardId:'rage'},targets:[{select:{cardId:'otter'},instruction:'Select target creature you control'},{select:{cardId:'enemy'},instruction:'Select target creature you do not control'}],payWith:['mana'],expectTargetTriggers:[{sourceId:'enemy',targetingCardId:'rage',abilityText:ward.abilityText}]},
    {kind:'choose',select:{label:'Yes'},guard:{kind:'question',instruction:'discard a card?'}},
    {kind:'choose',select:{cardId:'discard',zone:'hand'},guard:{kind:'target',instruction:'Select a card (discard cost)'}}],respond:({id,update,state})=>{
    if(id==='cast')update({ownHand:[discard],stack:[stack([])],decision:{id:'first-target',kind:'target',instruction:'Select target creature you control',choices:[{id:'own-target',card:otter}]}});
    else if(id==='first-target')update({stack:[stack(['otter'])],decision:{id:'second-target',kind:'target',instruction:'Select target creature you do not control',choices:[{id:'enemy-target',card:enemy}]}});
    else if(id==='second-target')update({stack:[stack(['otter','enemy'])],decision:{id:'pay',kind:'payMana',choices:[{id:'tap',card:land,type:'manaAbility'}]}});
    else if(id==='pay')update({stack:[stack(['otter','enemy']),ward],decision:priority('ward-priority')});
    else if(id==='ward-priority')update({sequenceEvidence:{...evidence(),resolutions:{ward:1},resolutionRevision:1},priority:'opponent',decision:{id:'ward-question',kind:'question',instruction:'discard a card?',choices:[{id:'yes',label:'Yes'}]}});
    else if(id==='ward-question')update({decision:{id:'discard-prompt',kind:'target',instruction:'Select a card (discard cost)',choices:[{id:'discard-choice',card:discard}]}});
    else if(id==='discard-prompt')update({ownHand:[],stack:[stack(['otter','enemy'])],priority:'self',decision:priority('rage-priority')});
    else update({stack:[],players:[state.players[0],{...state.players[1],battlefield:[],graveyard:[enemy]}],sequenceEvidence:{...evidence(),resolutions:{ward:1,'rage-stack':2},resolutionRevision:2},decision:priority('done')});
  }});
  assert.equal(result.status,'completed');assert.deepEqual(applied.map(([id])=>id),['cast','first-target','second-target','pay','ward-priority','ward-question','discard-prompt','rage-priority']);
  assert.equal(result.lastSubmission.acknowledged,true);assert.ok(result.lastSubmission.finishedAtEpochMs>=result.lastSubmission.dispatchedAtEpochMs);
});

test('[PM-AC-09-RESPONSES] legacy Opt accepts known casting costs but never its future unseen library choice',async(t)=>{
  const opt={id:'opt',cardId:'opt',name:'Opt',types:['INSTANT'],rules:['Scry 1. Draw a card.']}, mana={id:'mana',cardId:'mana',name:'Island',types:['LAND']};
  const {result,applied}=await plan(t,{initial:{ownHand:[opt],players:[{id:'me',yourSeat:true,battlefield:[mana]},{id:'rival',life:20}],decision:priority('opt',{id:'opt-choice',card:opt})},legacySteps:[{kind:'answer',select:{cardId:'opt'},guard:{kind:'priority',priority:'self'},expectCast:true},{kind:'answer',select:{cardId:'mana'},guard:{kind:'payMana',priority:'self'}},{kind:'yield_priority',allowPlannedResolutions:true}],respond:({id,update})=>{
    if(id==='opt')update({ownHand:[],stack:[{...opt,id:'opt-stack',controllerId:'me'}],decision:{id:'pay',kind:'payMana',choices:[{id:'tap',card:mana}]}});
    else if(id==='pay')update({decision:priority('resolve')});
    else update({decision:{id:'scry',kind:'target',instruction:'Scry',informationBoundary:'library_choice',choices:[{id:'bottom'}]},sequenceEvidence:{...evidence(),resolutions:{'opt-stack':1},resolutionRevision:1}});
  }});
  assert.equal(result.reason,'new_information');assert.deepEqual(applied.map(([id])=>id),['opt','pay','resolve']);
});

test('[PM-AC-09-RESPONSES] Class activation, known payment and its targeted return trigger continue without fresh strategic calls',async(t)=>{
  const text='{3}{U}: Level 2', etb='When this Class becomes level 2, return target instant or sorcery card from your graveyard to your hand.';
  const island={id:'island',cardId:'island',name:'Island',types:['LAND']}, known={id:'known-spell',cardId:'known-spell',name:'Reckless Rage',types:['INSTANT']};
  const activation={id:'activation',sourceId:'talent',controllerId:'me',abilityType:'ACTIVATED_NONMANA',abilityText:text}, trigger={id:'return',sourceId:'talent',controllerId:'me',abilityType:'TRIGGERED_NONMANA',abilityText:etb};
  const {result,applied}=await plan(t,{initial:{ownHand:[],players:[{id:'me',yourSeat:true,battlefield:[talent,island],graveyard:[known],manaPool:{colorless:3}},{id:'rival',life:20}],decision:priority('level',{id:'level-choice',card:talent})},actions:[
    {kind:'choose',select:{cardId:'talent'},guard:{kind:'priority'},expectAbility:{sourceId:'talent',abilityText:text},expectTriggers:[{sourceId:'talent',abilityText:etb}]},
    {kind:'choose',select:{cardId:'island'},guard:{kind:'payMana'}},
    {kind:'choose',select:{cardId:'known-spell'},guard:{kind:'target',instruction:'Select target instant or sorcery card from your graveyard'}}],respond:({id,update,state})=>{
    if(id==='level')update({decision:{id:'class-pay',kind:'payMana',choices:[{id:'tap',card:island}]}});
    else if(id==='class-pay')update({stack:[activation],decision:priority('resolve-class')});
    else if(id==='resolve-class')update({stack:[],sequenceEvidence:{...evidence(),resolutions:{activation:1},resolutionRevision:1},decision:{id:'return-target',kind:'target',instruction:'Select target instant or sorcery card from your graveyard',choices:[{id:'return-known',card:known}]}});
    else if(id==='return-target')update({stack:[trigger],decision:priority('resolve-return')});
    else update({stack:[],ownHand:[known],players:[{...state.players[0],graveyard:[]},state.players[1]],sequenceEvidence:{...evidence(),resolutions:{activation:1,return:2},resolutionRevision:2},decision:priority('done')});
  }});
  assert.equal(result.status,'completed');assert.deepEqual(applied.map(([id])=>id),['level','class-pay','resolve-class','return-target','resolve-return']);
});

for(const menu of [false,true]) test(`[PM-AC-09-RESPONSES] an explicit priority response remains usable before an existing information spell resolves: picker ${menu}`,async(t)=>{
  const opt={id:'opt-stack',cardId:'opt',name:'Opt',controllerId:'me',types:['INSTANT'],rules:['Scry 1. Draw a card.']}, response={id:'response-card',cardId:'response-card',name:'Known response',types:['INSTANT'],rules:['Gain 2 life.']};
  const {result,applied}=await plan(t,{initial:{ownHand:[response],stack:[opt],decision:priority('respond',{id:'response-choice',card:response})},actions:[{kind:'play',select:{cardId:'response-card'},when:'priority'},...(menu?[{kind:'choose',select:{label:'Cast'},guard:{kind:'chooseAbility',instruction:'Choose spell or ability'}}]:[])],respond:({id,update})=>{
    if(id==='respond'&&menu)update({decision:{id:'menu',kind:'chooseAbility',instruction:'Choose spell or ability',choices:[{id:'cast',label:'Cast'}]}});
    else if(id==='respond'||id==='menu')update({ownHand:[],stack:[{...response,id:'response-stack',controllerId:'me'},opt],decision:priority('resolve-response')});
    else if(id==='resolve-response')update({stack:[opt],sequenceEvidence:{...evidence(),resolutions:{'response-stack':1},resolutionRevision:1},decision:priority('resolve-opt')});
    else update({decision:{id:'scry',kind:'target',instruction:'Scry',informationBoundary:'library_choice',choices:[{id:'bottom'}]},sequenceEvidence:{...evidence(),resolutions:{'response-stack':1,'opt-stack':2},resolutionRevision:2}});
  }});
  assert.equal(result.reason,'new_information');assert.equal(applied[0][0],'respond');assert.equal(applied.length,menu?4:3);
});

test('[PM-AC-09-RESPONSES] an information spell may include its known casting picker and payment before the result',async(t)=>{
  const opt={id:'opt',cardId:'opt',name:'Information mode spell',types:['INSTANT'],rules:['Scry 1. Draw a card.']};
  const {result,applied}=await plan(t,{initial:{ownHand:[opt],decision:priority('opt',{id:'opt-choice',card:opt})},actions:[{kind:'play',select:{cardId:'opt'}},{kind:'choose',select:{label:'Cast'},guard:{kind:'chooseAbility',instruction:'Choose spell or ability'}},{kind:'choose',select:{label:'Pay'},guard:{kind:'payMana'}}],respond:({id,update})=>{
    if(id==='opt')update({decision:{id:'menu',kind:'chooseAbility',instruction:'Choose spell or ability',choices:[{id:'cast',label:'Cast'}]}});
    else if(id==='menu')update({ownHand:[],stack:[{...opt,id:'s',controllerId:'me'}],decision:{id:'pay',kind:'payMana',choices:[{id:'pay-choice',label:'Pay'}]}});
    else if(id==='pay')update({decision:priority('resolve')});
    else update({sequenceEvidence:{...evidence(),resolutions:{s:1},resolutionRevision:1},decision:{id:'scry',kind:'target',instruction:'Scry',informationBoundary:'library_choice',choices:[{id:'bottom'}]}});
  }});
  assert.equal(result.reason,'new_information');assert.deepEqual(applied.map(([id])=>id),['opt','menu','pay','resolve']);
});

test('[PM-AC-09-RESPONSES] known choice tails cannot cross the information resolution even with no new card ID',async(t)=>{
  const opt={id:'opt',cardId:'opt',name:'Opt',types:['INSTANT'],rules:['Scry 1. Draw a card.']};
  const {result,applied}=await plan(t,{initial:{ownHand:[opt],decision:priority('opt',{id:'opt-choice',card:opt})},actions:[{kind:'play',select:{cardId:'opt'}},{kind:'choose',select:{label:'Yes'},guard:{kind:'question',instruction:'Known-looking question'}}],respond:({id,update})=>{
    if(id==='opt')update({ownHand:[],stack:[{...opt,id:'s',controllerId:'me'}],decision:priority('resolve')});
    else update({sequenceEvidence:{...evidence(),resolutions:{s:1},resolutionRevision:1},decision:{id:'after-information',kind:'question',instruction:'Known-looking question',choices:[{id:'yes',label:'Yes'}]}});
  }});
  assert.equal(result.reason,'new_information');assert.equal(applied.length,2);
});

test('[PM-AC-09-RESPONSES] calling heads before a flip is predetermined but the random outcome still stops the line',async(t)=>{
  const spell={id:'flip',cardId:'flip',name:'Flip spell',types:['INSTANT'],rules:['Flip a coin.']};
  const {result,applied}=await plan(t,{initial:{ownHand:[spell],decision:priority('flip',{id:'flip-choice',card:spell})},actions:[{kind:'play',select:{cardId:'flip'}},{kind:'choose',select:{label:'Heads'},guard:{kind:'question',instruction:'Heads or tails?'}}],respond:({id,update})=>{
    if(id==='flip')update({ownHand:[],stack:[{...spell,id:'s',controllerId:'me'}],decision:priority('resolve')});
    else if(id==='resolve')update({sequenceEvidence:{...evidence(),resolutions:{s:1},resolutionRevision:1},decision:{id:'heads',kind:'question',instruction:'Heads or tails?',choices:[{id:'heads-choice',label:'Heads'}]}});
    else update({stack:[],sequenceEvidence:{...evidence(),resolutions:{s:1},resolutionRevision:1,informationRevision:1},decision:priority('done')});
  }});
  assert.equal(result.reason,'new_information');assert.deepEqual(applied.map(([id])=>id),['flip','resolve','heads']);
});

for(const instruction of ['Known-looking question','Heads or tails?']) test(`[PM-AC-09-RESPONSES] explicit reevaluation fences unrecognized effects before a later known-looking choice: ${instruction}`,async(t)=>{
  const spell={id:'odd',cardId:'odd',name:'Unusual effect',types:['INSTANT'],rules:['An effect not classified by the preflight.']};
  const {result,applied}=await plan(t,{initial:{ownHand:[spell],decision:priority('odd',{id:'odd-choice',card:spell})},actions:[{kind:'play',select:{cardId:'odd'},reevaluateAfter:true},{kind:'choose',select:{label:'Yes'},guard:{kind:'question',instruction}}],respond:({id,update})=>{
    if(id==='odd')update({ownHand:[],stack:[{...spell,id:'s',controllerId:'me'}],decision:priority('resolve')});
    else update({sequenceEvidence:{...evidence(),resolutions:{s:1},resolutionRevision:1},decision:{id:'after-information',kind:'question',instruction,choices:[{id:'yes',label:'Yes'}]}});
  }});
  assert.equal(result.reason,'new_information');assert.equal(applied.length,2);
});

test('[PM-AC-09-RESPONSES] legacy preflight rejects an unseen scry predecision before the initial cast',async(t)=>{
  const opt={id:'opt',cardId:'opt',name:'Opt',types:['INSTANT'],rules:['Scry 1. Draw a card.']};
  await assert.rejects(plan(t,{initial:{ownHand:[opt],decision:priority('opt',{id:'opt-choice',card:opt})},legacySteps:[{kind:'answer',select:{cardId:'opt'},guard:{kind:'priority',priority:'self'},expectCast:true},{kind:'yield_priority',allowPlannedResolutions:true},{kind:'answer',select:{label:'Bottom'},guard:{kind:'target',instruction:'Scry'}}],respond:()=>assert.fail('No action before rejecting the blind scry tail')}),{code:'reevaluation_required'});
});

for(const land of [false,true]) test(`[PM-AC-09-RESPONSES] an explicitly terminal no-stack action cannot leave an assumed cost tail: ${land}`,async(t)=>{
  const card=land?{id:'land',cardId:'land',name:'Mountain',types:['LAND']}:bird;
  await assert.rejects(plan(t,{initial:{ownHand:[card],decision:priority('card',{id:'card-choice',card})},actions:[{kind:'play',select:{cardId:card.id},...(land?{}:{expectCast:false}),reevaluateAfter:true},{kind:'choose',select:{label:'Pay'},guard:{kind:'payMana'}}],respond:()=>assert.fail('Untracked terminal action must reject its tail before execution')}),{code:'reevaluation_required'});
});
