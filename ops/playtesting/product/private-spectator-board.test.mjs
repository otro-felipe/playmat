import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {test} from 'node:test'
import {privateSpectatorBoard} from './private-spectator-board.mjs'

test('every XMage concealment flag withholds the face, printing and object ID from private spectator card groups',()=>{
  const players=['One','Two'].map(name=>({name,playerId:randomUUID()}))
  const seat=players[0].playerId
  for (const flag of ['faceDown','hideInfo','cloaked','disguised','manifested','morphed']) {
    const id=randomUUID(), card={id,name:'Concealed fixture',expansionSetCode:'ABC',cardNumber:'123',[flag]:true}
    const cards={[id]:card}, group={cards}
    const data=privateSpectatorBoard({gameId:randomUUID(),status:'playing',players,view:{players},
      hands:{[seat]:cards},seatKnowledge:{[seat]:{lookedAt:[group],revealed:[group],topCard:card}}})
    assert.deepEqual(data.hands[seat],{},flag)
    assert.deepEqual(data.seatKnowledge[seat],{lookedAt:[],revealed:[]},flag)
    assert.ok(!JSON.stringify(data).includes(id),flag)
  }
})
