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

export async function listDecks(db, account, includeDeleted = false) {
  const { rows } = await db.query(
    'SELECT d.id, d.head AS revision, r.name, r.format, d.updated_at, d.removed FROM decks d LEFT JOIN deck_revisions r ON (r.account_id, r.deck_id, r.revision) = (d.account_id, d.id, d.head) WHERE d.account_id=$1 AND ($2 OR NOT d.removed) ORDER BY d.updated_at DESC, d.id',
    [account, includeDeleted],
  )
  return rows.map(row => ({ id: row.id, name: row.name, format: row.format, revision: row.revision, updatedAt: Number(row.updated_at), deleted: row.removed }))
}

export async function getDeck(db, account, deckId, revision) {
  if (!isId(deckId)) return null
  const { rows: [row] } = await db.query(
    'SELECT d.id, d.updated_at, d.removed, r.revision, r.name, r.format, r.metadata FROM decks d JOIN deck_revisions r ON (r.account_id, r.deck_id) = (d.account_id, d.id) WHERE d.account_id=$1 AND d.id=$2 AND r.revision=COALESCE($3, d.head) AND ($3 IS NOT NULL OR NOT d.removed)',
    [account, deckId, revision ?? null],
  )
  if (!row) return null
  const data = { ...row.metadata, id: row.id, name: row.name, format: row.format, updatedAt: Number(row.updated_at), cards: [], sideboard: [] }
  const { rows: entries } = await db.query(
    'SELECT zone, card_name, set_code, card_number, amount FROM deck_revision_cards WHERE account_id=$1 AND deck_id=$2 AND revision=$3 ORDER BY position',
    [account, deckId, row.revision],
  )
  for (const entry of entries) data[entry.zone].push({
    cardName: entry.card_name, setCode: entry.set_code, cardNumber: entry.card_number, amount: entry.amount,
  })
  return { id: deckId, name: row.name, format: row.format, revision: row.revision, updatedAt: data.updatedAt, data }
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

export async function putDeck(pool, account, deckId, { data, name, format, expectedRevision, updatedAt }) {
  const headName = String(name ?? data?.name ?? '').trim()
  const headFormat = libraryFormat(format ?? data?.format)
  if (!isId(deckId) || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new ProductError(400, 'Deck ID and expectedRevision are required')
  }
  if (!headName || headName.length > 200 || !headFormat || !data || !Array.isArray(data.cards) || !Array.isArray(data.sideboard)
    || data.cards.length + data.sideboard.length > 300 || ![...data.cards, ...data.sideboard].every(validateEntry)) {
    throw new ProductError(400, 'Provide a valid deck name, format and card list')
  }
  const { cards: rawCards, sideboard: rawSideboard, id, name: ignoredName, format: ignoredFormat, updatedAt: ignoredTime, ...metadata } = data
  const cards = canonicalCards(rawCards)
  const sideboard = canonicalCards(rawSideboard)
  return transaction(pool, async db => {
    if (expectedRevision === 0) {
      await db.query('INSERT INTO decks (account_id, id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [account, deckId])
    }
    const { rows: [entry] } = await db.query('SELECT head, updated_at, removed FROM decks WHERE account_id=$1 AND id=$2 FOR UPDATE', [account, deckId])
    if (!entry) throw new ProductError(404, 'Deck not found')
    if (entry.head !== expectedRevision || entry.removed) throw new ProductError(409, 'Deck revision has changed')
    const time = Math.max(Number(entry.updated_at) + 1, Number.isSafeInteger(updatedAt) ? updatedAt : Date.now())
    const revision = expectedRevision + 1
    await db.query('INSERT INTO deck_revisions (account_id,deck_id,revision,name,format,metadata) VALUES ($1,$2,$3,$4,$5,$6)', [
      account, deckId, revision, headName, headFormat, metadata,
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
    return { id: deckId, name: headName, format: headFormat, revision, updatedAt: time, data: { ...metadata, id: deckId, name: headName, format: headFormat, updatedAt: time, cards, sideboard } }
  })
}

export async function deleteDeck(db, account, deckId, expectedRevision, updatedAt = Date.now()) {
  if (!isId(deckId) || !Number.isInteger(expectedRevision) || expectedRevision < 1) throw new ProductError(400, 'Deck revision is required')
  const { rowCount } = await db.query(
    'UPDATE decks SET removed=TRUE, updated_at=GREATEST(updated_at+1,$4) WHERE account_id=$1 AND id=$2 AND head=$3 AND NOT removed',
    [account, deckId, expectedRevision, updatedAt],
  )
  if (!rowCount) throw new ProductError(409, 'Deck revision has changed')
}
