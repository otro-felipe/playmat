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

for (const [variant, options] of [
  ['label', { mode: 'Cast Unholy Annex' }],
  ['face name', { mode: 'Unholy Annex' }],
  ['other face by exact option', { modeId: 'spell-1' }],
  ['sole projected cast', {}],
  ['multiple legal faces', {}],
  ['unknown face', { mode: 'Wrong Door' }],
]) test(`[PM-LINE-SEM-2] Room face and declared mana stay in one play: ${variant}`, async (t) => {
  const room = { id: 'room', cardId: 'room', name: 'Unholy Annex // Ritual Chamber', types: ['ENCHANTMENT'] };
  const faces = ['Unholy Annex', 'Ritual Chamber'].map((spellName, index) => ({
    id: `face-${index}`, label: `Cast ${spellName}`, type: 'option', abilityType: 'SPELL', spellName, abilityId: `spell-${index}`,
  }));
  const expected = variant === 'other face by exact option' ? faces[1] : faces[0];
  const face = { ...room, id: 'room-stack', name: expected.spellName, controllerId: 'me' };
  const marsh = { id: 'marsh', name: 'Blooming Marsh', types: ['LAND'] };
  const swamps = Array.from({ length: expected === faces[1] ? 4 : 2 }, (_, index) => ({
    id: `swamp-${index + 1}`, name: 'Swamp', types: ['LAND'],
  }));
  const lands = [marsh, ...swamps];
  const manaOptions = ['B', 'G'].map((color) => ({ id: `make-${color}`, manaColors: [color], abilityType: 'ACTIVATED_MANA' }));
  const pay = (index) => ({ id: `payment-${index}`, kind: 'payMana',
    choices: [{ id: `tap-${lands[index].id}`, card: lands[index], objectId: lands[index].id }] });
  const { result, applied } = await plan(t, {
    initial: { ownHand: [room], players: [{ id: 'me', yourSeat: true, battlefield: lands }, { id: 'rival' }],
      decision: priority('open', { id: 'cast-room', card: room, objectId: room.id,
        spellAbilities: (variant === 'sole projected cast' ? faces.slice(0, 1) : faces).map(({ abilityId, label }) => ({ abilityId, label })) }) },
    actions: [{ kind: 'play', select: { objectId: room.id, zone: 'hand' }, ...options,
      payWith: [{ sourceId: marsh.id, color: 'B' }, ...swamps.map(({ id }) => id)] }],
    respond: ({ id, choice, update }) => {
      if (id === 'open') return update({ decision: { id: 'choose-face', kind: 'panel', sourceObjectId: room.id, choices: faces } });
      if (id === 'choose-face') {
        assert.equal(choice, expected.id);
        return update({ ownHand: [], stack: [face], decision: pay(0) });
      }
      if (id === 'payment-0') return update({ decision: { id: 'mana-panel', kind: 'panel', sourceObjectId: marsh.id, choices: manaOptions } });
      if (id === 'mana-panel') {
        assert.equal(choice, 'make-B');
        return update({ decision: pay(1) });
      }
      if (id.startsWith('payment-')) {
        const next = Number(id.split('-')[1]) + 1;
        return update({ decision: next < lands.length ? pay(next) : priority('resolve-room') });
      }
      if (id === 'resolve-room') return update({ stack: [], decision: priority('done'),
        sequenceEvidence: { ...evidence(), resolutions: { [face.id]: 1 }, resolutionRevision: 1 } });
      assert.fail(`Unexpected decision ${id}`);
    },
  });
  if (['multiple legal faces', 'unknown face'].includes(variant)) {
    assert.equal(result.reason, 'response_available');
    assert.deepEqual(applied.map(([, answer]) => answer), ['cast-room']);
  } else {
    assert.equal(result.status, 'completed', JSON.stringify(result.error));
    assert.deepEqual(applied.map(([, answer]) => answer),
      ['cast-room', expected.id, 'tap-marsh', 'make-B', ...swamps.map(({ id }) => `tap-${id}`), 'pass']);
  }
});

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
  const stack=(targetGroups, unpaid = true)=>({...rage,id:'rage-stack',controllerId:'me',unpaid,targets:targetGroups.flat(),spellTargetGroups:targetGroups});
  const ward={id:'ward',sourceId:'enemy',controllerId:'rival',abilityType:'TRIGGERED_NONMANA',abilityText:'Ward—Discard a card.'};
  const {result,applied}=await plan(t,{initial:{ownHand:[rage,discard],players:[{id:'me',yourSeat:true,battlefield:[otter,land]},{id:'rival',life:20,battlefield:[enemy]}],decision:priority('cast',{id:'rage-choice',card:rage})},actions:[
    {kind:'play',select:{cardId:'rage'},targets:[{select:{objectId:'enemy'},role:0,targetZone:'BATTLEFIELD'},{select:{objectId:'otter'},role:1,targetZone:'BATTLEFIELD'}],payWith:['mana'],expectTargetTriggers:[{sourceId:'enemy',targetingCardId:'rage',abilityText:ward.abilityText}]},
    {kind:'choose',select:{answer:true},guard:{kind:'question',instruction:'discard a card?',sourceObjectId:'enemy'}},
    {kind:'choose',select:{cardId:'discard',zone:'hand'},guard:{kind:'target',instruction:'Select a card (discard cost)',targetZone:'HAND',targetSourceId:'enemy'}}],respond:({id,update,state})=>{
    if(id==='cast')update({ownHand:[discard],stack:[stack([['enemy'],[]])],decision:{id:'second-target',kind:'target',instruction:'Select target creature you control',targetRole:1,targetSourceId:'rage',targetZone:'BATTLEFIELD',choices:[{id:'own-target',card:otter}]}});
    else if(id==='second-target')update({stack:[stack([['enemy'],['otter']])],decision:{id:'pay',kind:'payMana',choices:[{id:'tap',card:land,type:'manaAbility'}]}});
    else if(id==='pay')update({stack:[stack([['enemy'],['otter']], false),ward],decision:priority('ward-priority')});
    else if(id==='ward-priority')update({sequenceEvidence:{...evidence(),resolutions:{ward:1},resolutionRevision:1},priority:'opponent',decision:{id:'ward-question',kind:'question',instruction:'discard a card?',sourceObjectId:'enemy',choices:[{id:'yes',answer:true}]}});
    else if(id==='ward-question')update({decision:{id:'discard-prompt',kind:'target',instruction:'Select a card (discard cost)',targetZone:'HAND',targetSourceId:'enemy',choices:[{id:'discard-choice',card:discard}]}});
    else if(id==='discard-prompt')update({ownHand:[],stack:[stack([['enemy'],['otter']], false)],priority:'self',decision:priority('rage-priority')});
    else update({stack:[],players:[state.players[0],{...state.players[1],battlefield:[],graveyard:[enemy]}],sequenceEvidence:{...evidence(),resolutions:{ward:1,'rage-stack':2},resolutionRevision:2},decision:priority('done')});
  }});
  assert.equal(result.status,'completed');assert.deepEqual(applied.map(([id])=>id),['cast','second-target','pay','ward-priority','ward-question','discard-prompt','rage-priority']);
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

for (const outcome of ['lethal', 'rival-response', 'missing-combat-witness', 'nonterminal-lethal-cleanup']) {
  test(`[PM-LINE-SEM-3] one Rage line starts at eight life and handles ${outcome}`, async (t) => {
    const rivalResponds = outcome === 'rival-response';
    const missingCombatWitness = outcome === 'missing-combat-witness';
    const wardText = 'Ward—Discard a card.';
    const prowessText = 'Prowess (Whenever you cast a noncreature spell, this creature gets +1/+1 until end of turn.)';
    const nemesisText = 'Whenever Screaming Nemesis is dealt damage, it deals that much damage to any other target.';
    const rage = { id: 'rage-card', cardId: 'rage-card', name: 'Reckless Rage', types: ['INSTANT'] };
    const kumano = { id: 'kumano', cardId: 'kumano', name: 'Kumano Faces Kakkazan', types: ['ENCHANTMENT'] };
    const basic = { id: 'mountain', cardId: 'mountain', name: 'Mountain', types: ['LAND'] };
    const nemesis = { id: 'nemesis', cardId: 'nemesis', name: 'Screaming Nemesis', types: ['CREATURE'],
      controllerId: 'me', power: '4', toughness: '4', rules: [nemesisText] };
    const swift = { id: 'swift', cardId: 'swift', name: 'Monastery Swiftspear', types: ['CREATURE'],
      controllerId: 'me', power: '1', toughness: '2', rules: [prowessText] };
    const trespasser = { id: 'trespasser', cardId: 'trespasser', name: 'Graveyard Trespasser', types: ['CREATURE'],
      controllerId: 'rival', power: '3', toughness: '3', rules: [wardText] };
    const pilot = { id: 'me', yourSeat: true, battlefield: [nemesis, swift, basic] };
    const rival = { id: 'rival', life: 8, handCount: 6, libraryCount: 39, battlefield: [trespasser] };
    const cast = (groups, unpaid = true) => ({ ...rage, id: 'rage-cast', controllerId: 'me',
      unpaid, spellTargetGroups: groups, targets: groups.flat() });
    const targeted = cast([[trespasser.id], [nemesis.id]], false);
    const triggered = (id, sourceId, abilityText, controllerId = 'me') => ({ id, sourceId, abilityText, controllerId,
      abilityType: 'TRIGGERED_NONMANA' });
    // The battlefield's rules capitalize Ward, while the stack exposes the keyword's raw rule.
    const ward = { ...triggered('ward', trespasser.id, 'ward—Discard a card.', 'rival'), targets: [targeted.id] };
    const prowess = triggered('prowess', swift.id, prowessText);
    const hurt = triggered('nemesis-trigger', nemesis.id, nemesisText);
    const resolutions = (...ids) => ({ ...evidence(), resolutionRevision: ids.length,
      resolutions: Object.fromEntries(ids.map((id, index) => [id, index + 1])) });
    const power2 = { ...swift, power: '2', toughness: '3' };
    const damagedNemesis = { ...nemesis, damage: 2 };
    const withNoBlocker = { ...rival, battlefield: [], graveyard: [trespasser] };
    const confirm = { id: 'confirm', intent: 'confirm_attack' };
    const declare = (id, ...choices) => ({ id, kind: 'declareAttackers', choices: [...choices, confirm] });
    const object = card => ({ id: card.id, objectId: card.id, card });
    const group = (...attackers) => [{ defenderId: rival.id, attackers, blockers: [], isBlocked: false }];
    const { result, applied, state } = await plan(t, {
      initial: { ownHand: [rage, kumano], players: [pilot, rival], decision: priority('announce', object(rage)) },
      actions: [
        { kind: 'play', select: { objectId: rage.id },
          targets: [trespasser, nemesis].map((card, role) => ({ role, targetZone: 'BATTLEFIELD', select: { objectId: card.id } })),
          payWith: [basic.id], expectTargetTriggers: [{ targetingCardId: rage.cardId, sourceId: trespasser.id, abilityText: wardText }],
          expectTriggers: [{ sourceId: swift.id, abilityText: prowessText }, { sourceId: nemesis.id, abilityText: nemesisText }] },
        { kind: 'choose', guard: { kind: 'question', sourceObjectId: trespasser.id, instruction: 'discard a card?' },
          select: { answer: true } },
        { kind: 'choose', guard: { kind: 'target', targetSourceId: trespasser.id, targetZone: 'HAND', instruction: 'Select a card (discard cost)' },
          select: { objectId: kumano.id, zone: 'hand' } },
        { kind: 'choose', guard: { kind: 'target', targetSourceId: nemesis.id, targetRole: 0 }, select: { objectId: rival.id } },
        { kind: 'attack', attackers: [nemesis.id, swift.id] },
        { kind: 'pass_until', destination: 'end_step', policy: 'decline_optional' },
      ],
      respond: ({ id, update, state: before }) => {
        switch (id) {
          case 'announce': return update({ ownHand: [kumano], stack: [cast([[trespasser.id], []])],
            decision: { id: 'role-one', kind: 'target', targetZone: 'BATTLEFIELD', targetSourceId: rage.id, targetRole: 1, choices: [object(nemesis)] } });
          case 'role-one': return update({ stack: [{ ...targeted, unpaid: true }],
            decision: { id: 'payment', kind: 'payMana', paymentSourceId: rage.id, choices: [object(basic)] } });
          case 'payment': return update({ stack: [targeted, prowess, ward],
            decision: priority('before-ward') });
          case 'before-ward': {
            if (rivalResponds) return update({ sequenceEvidence: { ...evidence(), publicActions: { me: 0, rival: 1 } },
              stack: [...before.stack, { id: 'rival-response', name: 'Fatal Push', controllerId: 'rival', targets: [swift.id] }],
              decision: priority('respond') });
            return update({ sequenceEvidence: resolutions(ward.id), decision: { id: 'ward-question', kind: 'question',
              instruction: 'discard a card?', sourceObjectId: trespasser.id, choices: [{ id: 'yes', answer: true }] } });
          }
          case 'ward-question': return update({ decision: { id: 'ward-cost', kind: 'target', instruction: 'Select a card (discard cost)',
            targetSourceId: trespasser.id, targetZone: 'HAND', choices: [object(kumano)] } });
          case 'ward-cost': return update({ ownHand: [], players: [{ ...pilot, graveyard: [kumano] }, rival],
            stack: [targeted, prowess], decision: priority('before-prowess') });
          case 'before-prowess': return update({ sequenceEvidence: resolutions(ward.id, prowess.id), stack: [targeted],
            players: [{ ...before.players[0], battlefield: [nemesis, power2, basic] }, rival], decision: priority('before-rage') });
          case 'before-rage': return update({ sequenceEvidence: resolutions(ward.id, prowess.id, targeted.id), stack: [hurt],
            players: [{ ...before.players[0], battlefield: [damagedNemesis, power2, basic] }, withNoBlocker],
            decision: { id: 'nemesis-target', kind: 'target', targetZone: 'ALL', targetRole: 0, targetSourceId: nemesis.id,
              choices: [{ id: 'rival-player', objectId: rival.id }] } });
          case 'nemesis-target': return update({ stack: [{ ...hurt, targets: [rival.id] }], decision: priority('before-nemesis') });
          case 'before-nemesis': return update({ sequenceEvidence: resolutions(ward.id, prowess.id, targeted.id, hurt.id), stack: [],
            players: [before.players[0], { ...withNoBlocker, life: 6 }], decision: priority('begin-combat') });
          case 'begin-combat': return update({ step: 'DECLARE_ATTACKERS', decision: declare('choose-nemesis', object(damagedNemesis), object(power2)) });
          case 'choose-nemesis': return update({ combat: group(damagedNemesis), decision: declare('choose-swift', object(power2)) });
          case 'choose-swift': return update({ combat: group(damagedNemesis, power2), decision: declare('submit-attack') });
          case 'submit-attack': return update({ step: 'DECLARE_BLOCKERS', decision: priority('combat-damage') });
          case 'combat-damage': {
            const firstHit = { revision: 1, sourceId: nemesis.id, controllerId: 'me', targetId: rival.id, amount: 4 };
            const secondHit = { revision: 2, sourceId: swift.id, controllerId: 'me', targetId: rival.id, amount: 2 };
            // LOST_LIFE's inform callback precedes DAMAGED_PLAYER for each hit.
            update({ step: 'COMBAT_DAMAGE', players: [before.players[0], { ...withNoBlocker, life: 2 }], decision: null });
            update({ players: [before.players[0], { ...withNoBlocker, life: 0 }],
              sequenceEvidence: { ...before.sequenceEvidence, combatRevision: 1, combatDamage: [firstHit] } });
            if (missingCombatWitness) return update({ decision: priority('unproved-actionable-frame') });
            update({ sequenceEvidence: { ...before.sequenceEvidence, combatRevision: 2, combatDamage: [firstHit, secondHit] } });
            // XMage removes the losing player's zones before sending GAME_OVER.
            update({ players: [before.players[0], { ...withNoBlocker, life: 0, handCount: 0, libraryCount: 0, graveyard: [] }] });
            if (outcome === 'nonterminal-lethal-cleanup') return update({ decision: priority('unexpected-after-lethal') });
            return update({ status: 'game_over' });
          }
          default: assert.fail(`Unexpected action in one-line lethal: ${id}`);
        }
      },
    });
    assert.equal(result.skippedSteps, 1);
    assert.equal(result.reason, {
      lethal: 'invalidated', 'rival-response': 'opponent_action', 'missing-combat-witness': 'opponent_state_changed',
      'nonterminal-lethal-cleanup': 'opponent_state_changed',
    }[outcome], JSON.stringify(result));
    if (rivalResponds) {
      assert.deepEqual(applied.map(([id]) => id), ['announce', 'role-one', 'payment', 'before-ward']);
      assert.deepEqual(state.ownHand, [kumano]);
      assert.equal(state.players[1].life, 8);
    } else {
      assert.deepEqual(applied.slice(-5).map(([id]) => id), ['begin-combat', 'choose-nemesis', 'choose-swift', 'submit-attack', 'combat-damage']);
      assert.equal(state.players[1].life, 0);
      assert.deepEqual(state.players[0].graveyard, [kumano]);
    }
  });
}
