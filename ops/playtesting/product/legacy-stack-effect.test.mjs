import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { deflateRawSync } from 'node:zlib'
import { createCatalogStackLookup, legacyStackEffect } from './legacy-stack-effect.mjs'

const name = 'Catalog Fixture'
const source = { name, kind:'card', expansionSetCode:'SYN', cardNumber:'17' }
const rule = 'Whenever {this} enters, draw a card.'

function catalog(t, view) {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY, value BLOB);
    CREATE TABLE printings(id INTEGER PRIMARY KEY, name TEXT, view BLOB);
    CREATE TABLE exact(set_code TEXT, card_number TEXT, printing INTEGER, PRIMARY KEY(set_code,card_number));`)
  const dictionary = Buffer.from('secondCardFace.expansionSetCode.cardNumber.name.rules')
  db.prepare('INSERT INTO meta VALUES(?,?)').run('viewDictionary',dictionary)
  db.prepare('INSERT INTO exact VALUES(?,?,?)').run('syn','17',1)
  db.prepare('INSERT INTO printings VALUES(?,?,?)').run(1,name,deflateRawSync(JSON.stringify(view),{dictionary}))
  return createCatalogStackLookup(db)
}

test('[CUP-AC-006] recovers an independent full triggered declaration from the exact catalog printing', t => {
  const lookup=catalog(t,{...source,rules:[`<i>Training</i> &mdash; ${rule}`,'{T}: Add {U}.']})
  const archived={sourceCard:source,rules:[`<i>Training</i> &mdash; ${rule.replace('{this}',name)}`,'PRIVATE CONTEXT']}
  assert.equal(legacyStackEffect(archived,source,'triggered',lookup),`Training — ${rule.replace('{this}',name)}`)
  assert.equal(legacyStackEffect(archived,source,'activated',lookup),undefined)
  assert.equal(legacyStackEffect({...archived,rules:['{T}: Add {U}.']},source,'activated',lookup),'{T}: Add {U}.')
  assert.equal(legacyStackEffect({...archived,rules:[archived.rules[0]+' PRIVATE CONTEXT']},source,'triggered',lookup),undefined)
  assert.equal(legacyStackEffect({...archived,sourceCard:{...source,hideInfo:true}},source,'triggered',lookup),undefined)
  assert.equal(legacyStackEffect(archived,undefined,'triggered',lookup),undefined)
  assert.equal(legacyStackEffect(archived,{...source,cardNumber:'18'},'triggered',lookup),undefined)
})

test('[CUP-AC-006] withholds ambiguous or malformed declarations and mismatched printings', t => {
  const archived={sourceCard:source,rules:[rule]}
  for (const view of [
    {...source,rules:[rule,rule]},
    {...source,expansionSetCode:'OTHER',rules:[rule]},
    {...source,name:'Different face',rules:[rule]},
    {...source,rules:[`<span color="green">${rule}</span>`]},
  ]) assert.equal(legacyStackEffect(archived,source,'triggered',catalog(t,view)),undefined)
})
