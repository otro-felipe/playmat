import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createSpectators } from './spectators.mjs'

test('only the browser host can share; a public link is stable, read-only and independent of account or game ID', async () => {
  const tableId = randomUUID(), actor = { username:'Host', accountId:randomUUID() }, rows=new Map()
  const state={role:'spectator',tableId,gameId:null,status:'waiting',players:[],view:null,hands:{},lines:[],chat:[]}
  const seats=createSpectators({
    readEngine:async table=>table===tableId?{owner:'Host',snapshot:state}:null,
    storage:{
      issue:async (id,owner,token)=>{ if(!rows.has(id)) rows.set(id,{tableId:id,owner,token}); return rows.get(id).token },
      table:async token=>[...rows.values()].find(row=>row.token===token)?.tableId,
      mayObserve:async (id,account)=>id===tableId && account===actor.accountId,
    }})
  const share=await seats.share(actor,tableId)
  assert.match(share.path,/^\/watch\/[A-Za-z0-9_-]{43}$/)
  assert.equal((await seats.share(actor,tableId)).path,share.path)
  assert.notEqual(share.path,'/watch/'+tableId)
  await assert.rejects(()=>seats.share({...actor,username:'Friend'},tableId))
  await assert.rejects(()=>seats.share({...actor,agent:true},tableId))
  await assert.rejects(()=>seats.publicTableId(tableId))
  assert.equal(await seats.publicTableId(share.path.split('/').at(-1)),tableId)
  state.view={lookedAt:['private'],seatViews:{},players:[{name:'Host',userData:{private:'setting'}}],turn:1}
  const projected=await seats.snapshot(tableId)
  assert.equal(projected.role,'spectator')
  assert.deepEqual(projected.view,{players:[{name:'Host'}],turn:1})
  await assert.rejects(()=>seats.privateTableId({...actor,accountId:randomUUID()},tableId))
  assert.equal(await seats.privateTableId(actor,tableId),tableId)
  seats.close()
})
