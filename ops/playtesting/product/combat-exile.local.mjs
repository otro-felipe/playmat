// Two public-play reconstructions with fresh synthetic seats in the opt-in XMage fixture.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const mountain = 'Mountain', swamp = 'Swamp'
const saga = 'Kumano Faces Kakkazan', etching = 'Etching of Kumano', rage = 'Monstrous Rage'
const nemesis = 'Screaming Nemesis', swift = 'Monastery Swiftspear'
const trespasser = 'Graveyard Trespasser', glutton = 'Graveyard Glutton', sheoldred = 'Sheoldred, the Apocalypse'
const printings = {
  [mountain]: ['DMU', '271'], [swamp]: ['DMU', '268'], [saga]: ['NEO', '152'], [rage]: ['WOE', '142'],
  [nemesis]: ['DSK', '157'], [swift]: ['KTK', '118'], [trespasser]: ['MID', '104'], [sheoldred]: ['DMU', '107'],
}
const deck = (name, basic, spells) => ({ name, cards: [basic, ...spells].map(cardName => ({
  cardName, setCode: printings[cardName][0], cardNumber: printings[cardName][1],
  amount: cardName === basic ? 60 - 4 * spells.length : 4,
})), sideboard: [] })
const permanent = (player, name) => player.battlefield.find(card => card.name === name)
const select = (state, id) => id && state.decision.choices.find(choice => (choice.objectId ?? choice.card?.id) === id)
const play = (state, name) => select(state, state.ownHand.find(card => card.name === name)?.id)
const main = (state, player) => state.activePlayerId === player.id && state.step === 'PRECOMBAT_MAIN'
  && state.decision.kind === 'priority' && !state.stack.length
const assigned = (state, role, id) => state.combat.some(group => group[role]?.some(card => card.id === id))
const boundary = state => ({ gameId: state.gameId, turn: state.turn, activePlayerId: state.activePlayerId })
const confirmation = (state, intent) => state.decision.choices.find(choice => choice.intent === intent)
function routine(state, player, basic) {
  const { decision } = state
  if (decision.kind === 'payMana') {
    return decision.choices.find(choice => player.battlefield.some(card => card.id === choice.card?.id && card.name === basic && !card.tapped))
  }
  if (decision.kind === 'target' && state.step === 'CLEANUP') return play(state, basic)
    || decision.choices.find(choice => state.ownHand.filter(card => card.name === choice.card?.name).length > 1)
  return decision.choices.find(choice => /^Keep\b|^Play first\b/.test(choice.label) || choice.type === 'pass')
    || confirmation(state, 'confirm_attack') || confirmation(state, 'confirm_block')
}

async function exercise(fixture, defending) {
  const { startFixture, ownPlayer, rivalPlayer, answer, waitNextOwn, playLineWithPeer, call, setRivalSetup, gameClock } = fixture
  const partnerName = defending ? swift : nemesis
  let pilotReady = false, engage = false, paired = false
  setRivalSetup(state => {
    const rival = ownPlayer(state), pilot = rivalPlayer(state)
    const wolves = rival.battlefield.filter(card => [trespasser, glutton].includes(card.name))
    const [werewolf, extra] = wolves
    const legend = permanent(rival, sheoldred)
    if (main(state, rival)) {
      const land = rival.battlefield.filter(card => card.name === swamp).length < 5 && play(state, swamp)
      if (land) return land
      if (pilotReady && wolves.length < (defending ? 2 : 1)) return play(state, trespasser)
      if (pilotReady && defending && werewolf && extra && !legend) return play(state, sheoldred)
    }
    if (state.decision.kind === 'declareBlockers' && engage && !defending && werewolf
      && !assigned(state, 'blockers', werewolf.id)) return select(state, werewolf.id)
    if (!defending && /select attacker to block/i.test(state.decision.instruction)) return select(state, permanent(pilot, etching).id)
    if (state.decision.kind === 'declareAttackers' && defending && werewolf?.name === glutton && legend && extra) {
      const next = [legend, werewolf, extra].find(card => !assigned(state, 'attackers', card.id))
      if (next) return select(state, next.id) ?? confirmation(state, 'confirm_attack')
      engage = true
    }
    if (state.decision.triggerOrder) {
      return state.decision.choices.find(choice => wolves.some(card => choice.triggerSourceId === card.id))
    }
    if (state.decision.kind === 'target') {
      const skipExile = state.decision.choices.find(choice => /^(Done|Skip)$/i.test(choice.label))
      if (skipExile) return skipExile
    }
    return routine(state, rival, swamp)
  })
  let state = await startFixture('Isolated combat exile ' + (defending ? 'on defense' : 'on offense'),
    deck('Isolated red replacement', mountain, [saga, rage, partnerName]), 2753,
    deck('Isolated black combatants', swamp, defending ? [sheoldred, trespasser] : [trespasser]), 'Pioneer')
  try {
    while (gameClock.hasTime()) {
      const pilot = ownPlayer(state), rival = rivalPlayer(state), decision = state.decision
      const source = permanent(pilot, etching), partner = permanent(pilot, partnerName)
      const werewolf = permanent(rival, defending ? glutton : trespasser)
      const pump = state.ownHand.find(card => card.name === rage)
      const lands = pilot.battlefield.filter(card => card.name === mountain)
      pilotReady ||= Boolean(source && partner && pump && lands.length >= 3)
      if (defending && engage && decision.kind === 'declareBlockers' && !paired) {
        const block = { kind: 'block', assignments: [{ blockerId: source.id, attackerId: permanent(rival, sheoldred).id },
          { blockerId: partner.id, attackerId: werewolf.id }] }
        const declared = await playLineWithPeer({ gameId: state.gameId, cursor: state.cursor,
          commandId: randomUUID(), actions: [block] }, boundary(state))
        assert.equal(declared.status, 'completed', declared.reason)
        paired = true
        state = await waitNextOwn(decision.id)
        continue
      }
      if (defending && paired && source?.power === '5' && state.step === 'DECLARE_BLOCKERS'
        && decision.kind === 'priority' && !state.stack.length) break
      if (!defending && decision.choices.some(choice => choice.type === 'numbers')) break
      let choice
      if (main(state, pilot)) {
        choice = lands.length < 5 && play(state, mountain)
        if (!choice && !source && !permanent(pilot, saga)) choice = play(state, saga)
        if (!choice && source && !partner) choice = play(state, partnerName)
        if (!defending && pilotReady && werewolf) engage = true
      }
      if (engage && (!defending || paired) && source?.power === '2' && decision.kind === 'priority' && !state.stack.length
        && state.step === 'DECLARE_BLOCKERS' && assigned(state, 'blockers', (defending ? source : werewolf).id)) choice = play(state, rage)
      if (decision.kind === 'target' && source && decision.choices.some(item => item.card?.id === source.id)) choice = select(state, source.id)
      if (!defending && engage && decision.kind === 'declareAttackers') {
        const next = [source, partner].find(card => !assigned(state, 'attackers', card.id))
        choice = next && select(state, next.id)
      }
      choice ||= routine(state, pilot, mountain)
      assert.ok(choice, 'Unexpected isolated combat setup decision ' + decision.kind + ' ' + decision.instruction)
      await answer(state, choice)
      state = await waitNextOwn(decision.id)
    }
    const pilot = ownPlayer(state), rival = rivalPlayer(state), source = permanent(pilot, etching)
    const partner = permanent(pilot, partnerName), casualty = permanent(rival, defending ? sheoldred : trespasser)
    assert.equal(source.power, '5')
    assert.equal(source.toughness, '3')
    assert.ok(partner && casualty)
    const wolves = rival.battlefield.filter(card => card.name === glutton)
    const gluttonCard = wolves.find(card => state.combat.some(group => group.attackers.some(attacker => attacker.id === card.id)
      && group.blockers.some(blocker => blocker.id === partner.id)))
    const unblockedGlutton = wolves.find(card => state.combat.some(group => group.attackers.some(attacker => attacker.id === card.id)
      && group.blockers.length === 0))
    const actions = []
    if (defending) {
      assert.equal(wolves.length, 2)
      assert.ok(gluttonCard && unblockedGlutton && gluttonCard.id !== unblockedGlutton.id)
      assert.equal(state.step, 'DECLARE_BLOCKERS')
      assert.ok(state.combat.some(group => group.attackers.some(card => card.id === casualty.id)
        && group.blockers.some(card => card.id === source.id)))
    } else {
      assert.equal(partner.power, '3')
      assert.equal(casualty.toughness, '3')
      assert.ok(state.combat.some(group => group.attackers.some(card => card.id === source.id)
        && group.blockers.some(card => card.id === casualty.id)))
      assert.equal(state.decision.amounts.items.length, 1)
      actions.push({ kind: 'choose', decisionId: state.decision.id, choiceId: state.decision.choices.find(choice => choice.type === 'numbers').id, value: [3] })
    }
    actions.push({ kind: 'pass_until', destination: 'end_step', policy: 'decline_optional' })
    const receipt = await playLineWithPeer({ gameId: state.gameId, cursor: state.cursor, commandId: randomUUID(), waitMs: 15_000, actions },
      boundary(state))
    const after = receipt.state, them = rivalPlayer(after), us = ownPlayer(after)
    const inZone = (zone, card) => zone.some(entry => entry.cardId === card.cardId || entry.id === card.cardId)
    assert.ok(casualty.cardId && source.cardId && partner.cardId, 'Physical card identity is available for every checked object')
    assert.ok(inZone(them.exile, casualty), 'Exact opposing combatant reached public exile')
    assert.ok(inZone(us.graveyard, source), 'Same physical Kumano returned to its front face in the graveyard')
    assert.equal(them.life, rival.life - (defending ? 0 : 5))
    assert.equal(us.life, pilot.life - (defending ? 4 : 0))
    if (defending) {
      assert.ok(inZone(us.graveyard, partner))
      assert.ok(wolves.every(wolf => them.battlefield.some(card => card.id === wolf.id)))
    } else {
      assert.ok(us.battlefield.some(card => card.id === partner.id))
    }
    const hits = after.sequenceEvidence.combatDamage.filter(hit => hit.revision > state.sequenceEvidence.combatRevision)
    const expectedHits = defending
      ? [[source.id, casualty.id, 5], [casualty.id, source.id, 4], [partner.id, gluttonCard.id, 2],
        [gluttonCard.id, partner.id, 4], [unblockedGlutton.id, pilot.id, 4]]
      : [[source.id, casualty.id, 3], [casualty.id, source.id, 3], [source.id, rival.id, 2], [partner.id, rival.id, 3]]
    assert.deepEqual(hits.map(hit => [hit.sourceId, hit.targetId, hit.amount]).sort(), expectedHits.sort(),
      'Every point of damage belongs to its witnessed source and target')
    console.log(JSON.stringify({ phase: 'real XMage combat exile', defending, lifeBefore: [pilot.life, rival.life],
      lifeAfter: [us.life, them.life], exactExile: true, exactFriendlyGraveyard: true, hits: hits.length,
      status: receipt.status, reason: receipt.reason, destination: receipt.lastDestination?.step }))
    assert.equal(receipt.status, 'completed', receipt.error?.message ?? receipt.reason)
    assert.equal(receipt.lastDestination?.step, 'END_TURN')
  } finally {
    setRivalSetup(undefined)
    await call('concede', { gameId: state.gameId, entireMatch: true })
  }
}
export async function verifyCombatExile(fixture) {
  const failures = []
  for (const defending of [false, true]) {
    try { await exercise(fixture, defending) }
    catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'Isolated XMage combat exile regressions')
}
