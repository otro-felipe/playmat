import { randomUUID } from 'node:crypto'
import { open, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isUuid, ProductError } from './decks.mjs'
import { lineText } from './line-explanations.mjs'

/** Index only the viewer projection, never the raw archive. An unlinked file lives
 * until its final reader closes it, including across cache evictions and process exits. */
async function buildIndex(records, game, project) {
  const path = join(tmpdir(), 'playmat-replay-' + randomUUID())
  const file = await open(path, 'wx+', 0o600)
  try {
    await unlink(path)
    const frames = [],
      lines = [],
      seen = new Set()
    let offset = 0
    async function append(value) {
      const bytes = Buffer.from(JSON.stringify(value))
      const entry = { offset, length: bytes.length }
      await file.writeFile(bytes)
      offset += bytes.length
      return entry
    }
    async function load(entry) {
      const bytes = Buffer.allocUnsafe(entry.length)
      let read = 0
      while (read < bytes.length) {
        const { bytesRead } = await file.read(bytes, read, bytes.length - read, entry.offset + read)
        if (!bytesRead) throw new ProductError(503, 'Replay frame is unavailable')
        read += bytesRead
      }
      return JSON.parse(bytes.toString('utf8'))
    }
    for await (const record of records) {
      const note = record.kind === 'line' && lineText(record)
      if (
        note &&
        isUuid(record.actorPlayerId) &&
        typeof record.commandId === 'string' &&
        record.commandId.length > 0 &&
        record.commandId.length <= 120
      ) {
        const lineId = game.id + ':' + record.actorPlayerId + ':' + record.commandId
        if (!seen.has(lineId)) {
          seen.add(lineId)
          lines.push(
            await append({
              lineId,
              playerId: record.actorPlayerId,
              ...note,
              turn: record.turn,
              at: record.at ?? Number(game.started_at) + record.t,
            }),
          )
        }
      }
      if (record.view?.players?.length !== 2) continue
      const board = await append(project(record, frames.length))
      frames.push({ ...board, lineCount: lines.length })
    }
    if (frames.length) frames.at(-1).lineCount = lines.length
    return {
      count: frames.length,
      async frame(number) {
        const frame = frames[number]
        if (!frame) throw new ProductError(404, 'This tournament broadcast is unavailable')
        const recent = lines.slice(Math.max(0, frame.lineCount - 100), frame.lineCount)
        const [board, notes] = await Promise.all([load(frame), Promise.all(recent.map(load))])
        return { board, lines: notes }
      },
      close: () => file.close(),
    }
  } catch (error) {
    await file.close()
    throw error
  }
}

/** A bounded number of readers may build indexes. Identical concurrent requests
 * share a build; a viewer seeking while an entry is evicted retains its file. */
export function tournamentReplayIndexes(archive) {
  const entries = new Map(),
    counts = new Map(),
    waiters = []
  let builders = 0,
    reclaiming
  async function releaseIdle(keep) {
    const closing = []
    for (const [key, entry] of entries) {
      if (entries.size <= keep) break
      if (entry.users || !entry.index) continue
      entries.delete(key)
      closing.push(entry.index.close())
    }
    await Promise.all(closing)
    return closing.length > 0
  }

  async function build(game, project) {
    if (builders >= 2) {
      if (waiters.length >= 32) throw new ProductError(503, 'Replay storage is busy. Try again shortly.')
      await new Promise((resolve) => waiters.push(resolve))
    } else {
      builders++
    }
    try {
      const attempt = () => buildIndex(archive.streamTournamentRecords(game), game, project)
      try {
        return await attempt()
      } catch (error) {
        if (error.code !== 'ENOSPC') throw error
        // Unlinked temp files return their blocks on close. Share reclamation
        // between builders, then reopen the archive from the start exactly once.
        reclaiming ??= releaseIdle(0).finally(() => {
          reclaiming = null
        })
        if (!(await reclaiming)) throw error
        return await attempt()
      }
    } finally {
      if (waiters.length) waiters.shift()()
      else builders--
    }
  }
  async function read(game, project, indexOnly, number) {
    const key = game.id + '/' + game.checksum
    if (indexOnly && counts.has(key)) return counts.get(key)
    let entry = entries.get(key)
    if (!entry) {
      entry = { users: 0 }
      entry.pending = build(game, project)
        .then((index) => {
          entry.index = index
          if (counts.size >= 128) counts.delete(counts.keys().next().value)
          counts.set(key, index.count)
          return index
        })
        .catch((error) => {
          if (entries.get(key) === entry) entries.delete(key)
          throw error
        })
    }
    entries.delete(key)
    entries.set(key, entry)
    entry.users++
    try {
      const index = await entry.pending
      return indexOnly ? index.count : await index.frame(number)
    } finally {
      entry.users--
      // Retain a full eight-player round for simultaneous spectators.
      await releaseIdle(4)
    }
  }
  async function close() {
    await Promise.all(
      [...entries.values()].map(async (entry) => {
        const index = await entry.pending.catch(() => null)
        await index?.close()
      }),
    )
    entries.clear()
    counts.clear()
  }
  return { read, close }
}
