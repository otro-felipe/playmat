import { archetypesFor, classifyArchetype, deckListSignature } from './deck-performance-identity.mjs'

export class ProductError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export const normalize = value => String(value ?? '').trim().toLowerCase()
export const isId = value => typeof value === 'string' && /^[a-z0-9_:.-]{1,64}$/i.test(value)
export const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)

const competitiveFormats = new Map([['standard', 'Standard'], ['pioneer', 'Pioneer'], ['modern', 'Modern']])

export function normalizeFormat(value) {
  const key = normalize(value).replace(/^constructed[\s-]+/, '')
  return competitiveFormats.get(key) ?? null
}

function libraryFormat(value) {
  if (value != null && typeof value !== 'string') return null
  const label = value?.trim() ?? ''
  if (!label || label.toLowerCase() === 'freeform') return 'Constructed - Freeform'
  if (label.length > 120 || /\p{Cc}/u.test(label)) return null
  const competitive = normalizeFormat(label)
  if (competitive) return competitive
  const engineFormat = label === 'Limited' || /^(?:(?:Block )?Constructed(?: Custom)?|Variant Magic) - \S/.test(label)
  return engineFormat ? label : null
}

export async function transaction(pool, work) {
  const db = await pool.connect()
  try {
    await db.query('BEGIN')
    const result = await work(db)
    await db.query('COMMIT')
    return result
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  } finally {
    db.release()
  }
}

function deckHeader(row) {
  return {
    id: row.id, library: row.library, revision: row.revision,
    name: row.name, format: row.format, archetype: row.archetype,
    listVersion: row.list_version, listSignature: row.list_signature, updatedAt: Number(row.updated_at),
  }
}

export async function listDecks(db, account, includeDeleted = false, library = null) {
  const { rows } = await db.query(
    'SELECT d.id, d.head AS revision, d.library, r.name, r.format, r.archetype, r.list_version, r.list_signature, d.updated_at, d.removed FROM decks d LEFT JOIN deck_revisions r ON (r.account_id, r.deck_id, r.revision) = (d.account_id, d.id, d.head) WHERE d.account_id=$1 AND ($2 OR NOT d.removed) AND ($3::text IS NULL OR d.library=$3) ORDER BY d.updated_at DESC, d.id',
    [account, includeDeleted, library],
  )
  return rows.map(row => ({ ...deckHeader(row), deleted: row.removed }))
}

export async function getDeck(db, account, deckId, revision) {
  if (!isId(deckId)) return null
  const { rows: [row] } = await db.query(
    'SELECT d.id, d.library, d.updated_at, d.removed, r.revision, r.name, r.format, r.archetype, r.list_version, r.list_signature, r.metadata FROM decks d JOIN deck_revisions r ON (r.account_id, r.deck_id) = (d.account_id, d.id) WHERE d.account_id=$1 AND d.id=$2 AND r.revision=COALESCE($3, d.head) AND ($3 IS NOT NULL OR NOT d.removed)',
    [account, deckId, revision ?? null],
  )
  if (!row) return null
  const header = deckHeader(row)
  const data = { ...row.metadata, ...header, cards: [], sideboard: [] }
  const { rows: entries } = await db.query(
    'SELECT zone, card_name, set_code, card_number, amount FROM deck_revision_cards WHERE account_id=$1 AND deck_id=$2 AND revision=$3 ORDER BY position',
    [account, deckId, row.revision],
  )
  for (const entry of entries) data[entry.zone].push({
    cardName: entry.card_name, setCode: entry.set_code, cardNumber: entry.card_number, amount: entry.amount,
  })
  return { ...header, data }
}

function validateEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
  const name = entry.cardName ?? entry.name
  const amount = entry.amount ?? entry.quantity ?? entry.count
  const set = entry.setCode ?? entry.set
  const number = entry.cardNumber ?? entry.number
  return typeof name === 'string' && name.trim().length > 0 && name.length <= 200
    && Number.isInteger(amount) && amount >= 1 && amount <= 250
    && (set == null || (typeof set === 'string' && set.length <= 20))
    && (number == null || (typeof number === 'string' && number.length <= 20))
}

function canonicalCards(entries) {
  return entries.map(entry => ({
    cardName: entry.cardName ?? entry.name,
    setCode: entry.setCode ?? entry.set ?? null,
    cardNumber: entry.cardNumber ?? entry.number ?? null,
    amount: entry.amount ?? entry.quantity ?? entry.count,
  }))
}

export async function putDeck(pool, account, deckId, { data, name, format, archetype: suppliedLabel, expectedRevision, updatedAt }, createdLibrary = 'personal') {
  const headName = String(name ?? data?.name ?? '').trim()
  const headFormat = libraryFormat(format ?? data?.format)
  if (!isId(deckId) || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new ProductError(400, 'Deck ID and expectedRevision are required')
  }
  if (!headName || headName.length > 200 || !headFormat || !data || !Array.isArray(data.cards) || !Array.isArray(data.sideboard)
    || data.cards.length + data.sideboard.length > 300 || ![...data.cards, ...data.sideboard].every(validateEntry)) {
    throw new ProductError(400, 'Provide a valid deck name, format and card list')
  }
  const requestedLabel = suppliedLabel ?? data.archetype
  const allowed = archetypesFor(headFormat)
  if (requestedLabel !== undefined && !allowed.includes(requestedLabel)) throw new ProductError(400, 'Choose a catalog archetype for this format')
  const { revision: ignoredRevision, archetype: ignoredLabel, listVersion: ignoredVersion, listSignature: ignoredSignature, cards: rawCards, sideboard: rawSideboard, id, name: ignoredName, format: ignoredFormat, library: ignoredLibrary, updatedAt: ignoredTime, ...metadata } = data
  const cards = canonicalCards(rawCards)
  const sideboard = canonicalCards(rawSideboard)
  const signature = deckListSignature({ cards, sideboard })
  return transaction(pool, async db => {
    if (expectedRevision === 0) {
      await db.query('INSERT INTO decks (account_id, id, library) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [account, deckId, createdLibrary])
    }
    const { rows: [entry] } = await db.query('SELECT head, library, updated_at, removed FROM decks WHERE account_id=$1 AND id=$2 FOR UPDATE', [account, deckId])
    if (!entry) throw new ProductError(404, 'Deck not found')
    if (entry.head !== expectedRevision || entry.removed) throw new ProductError(409, 'Deck revision has changed')
    const time = Math.max(Number(entry.updated_at) + 1, Number.isSafeInteger(updatedAt) ? updatedAt : Date.now())
    const revision = expectedRevision + 1
    const { rows: [identity] } = await db.query(`SELECT
       COALESCE(MAX(list_version) FILTER (WHERE list_signature=$3), MAX(list_version)+1, 1) AS version,
       MAX(archetype) FILTER (WHERE revision=$4 AND format=$5) AS previous
       FROM deck_revisions WHERE account_id=$1 AND deck_id=$2`, [account, deckId, signature, expectedRevision, headFormat])
    const archetype = requestedLabel ?? (allowed.includes(identity.previous) && identity.previous !== 'Other'
      ? identity.previous : classifyArchetype(headFormat, headName, cards))
    const listVersion = identity.version
    await db.query('INSERT INTO deck_revisions (account_id,deck_id,revision,name,format,metadata,archetype,list_version,list_signature) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
      account, deckId, revision, headName, headFormat, metadata, archetype, listVersion, signature,
    ])
    for (const [zone, entries] of Object.entries({ cards, sideboard })) {
      await db.query(
        `INSERT INTO deck_revision_cards (account_id,deck_id,revision,zone,position,card_name,set_code,card_number,amount)
          SELECT $1,$2,$3,$4,ord,value->>'cardName',value->>'setCode',value->>'cardNumber',(value->>'amount')::integer
          FROM jsonb_array_elements($5::jsonb) WITH ORDINALITY AS e(value,ord)`,
        [account, deckId, revision, zone, JSON.stringify(entries)],
      )
    }
    await db.query('UPDATE decks SET head=$3, updated_at=$4 WHERE account_id=$1 AND id=$2', [account, deckId, revision, time])
    const header = { id: deckId, name: headName, format: headFormat, archetype, listVersion, listSignature: signature, library: entry.library, revision, updatedAt: time }
    return { ...header, data: { ...metadata, ...header, cards, sideboard } }
  })
}

export async function moveDeckLibrary(db, account, deckId, library, expectedRevision) {
  if (!isId(deckId) || !['personal', 'agent'].includes(library) || !Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new ProductError(400, 'A valid library and deck revision are required')
  }
  const { rowCount } = await db.query(
    'UPDATE decks SET library=$3, updated_at=GREATEST(updated_at+1,$5) WHERE account_id=$1 AND id=$2 AND head=$4 AND NOT removed',
    [account, deckId, library, expectedRevision, Date.now()],
  )
  if (!rowCount) throw new ProductError(409, 'Deck revision has changed')
  return getDeck(db, account, deckId)
}

export async function deleteDeck(db, account, deckId, expectedRevision, updatedAt = Date.now()) {
  if (!isId(deckId) || !Number.isInteger(expectedRevision) || expectedRevision < 1) throw new ProductError(400, 'Deck revision is required')
  const { rowCount } = await db.query(
    'UPDATE decks SET removed=TRUE, updated_at=GREATEST(updated_at+1,$4) WHERE account_id=$1 AND id=$2 AND head=$3 AND NOT removed',
    [account, deckId, expectedRevision, updatedAt],
  )
  if (!rowCount) throw new ProductError(409, 'Deck revision has changed')
}

/** Own library metadata for historical attribution, including retired and restored lists. */
export async function performanceCatalog(db, accountId) {
  const { rows } = await db.query(`SELECT DISTINCT ON (d.id, r.list_signature, r.format)
    d.id, d.removed, head.name, head.format, head.archetype, head.list_version AS "currentVersion",
    r.revision, r.format AS "versionFormat", r.archetype AS "versionArchetype", r.list_version, r.list_signature
    FROM decks d JOIN deck_revisions head ON (d.account_id,d.id,d.head)=(head.account_id,head.deck_id,head.revision)
    JOIN deck_revisions r ON (d.account_id,d.id)=(r.account_id,r.deck_id)
    WHERE d.account_id=$1 ORDER BY d.id, r.list_signature, r.format, r.revision DESC`, [accountId])
  const families = new Map()
  for (const row of rows.sort((a, b) => b.revision - a.revision)) {
    const { id, name, format, archetype, currentVersion, removed } = row
    if (!families.has(id)) families.set(id, { id, name, format, archetype, currentVersion, removed, versions: [] })
    families.get(id).versions.push({ version: row.list_version, signature: row.list_signature, format: row.versionFormat, archetype: row.versionArchetype })
  }
  return [...families.values()]
}
