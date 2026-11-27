import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { inflateRawSync } from 'node:zlib'

export function openPrebuiltCardCatalog() {
  const file = '/opt/xmage/cards-prebuilt/catalog.sqlite'
  if (!existsSync(file)) return null
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')
  return new DatabaseSync(file,{readOnly:true})
}

export function cardViewDictionary(db) {
  return db.prepare("SELECT value FROM meta WHERE key='viewDictionary'").get()?.value
}

export function catalogCardView(compressed,dictionary) {
  return JSON.parse(inflateRawSync(compressed,{dictionary,maxOutputLength:1024*1024}))
}
