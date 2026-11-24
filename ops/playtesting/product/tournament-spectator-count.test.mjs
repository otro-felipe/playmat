import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { createTournamentRoutes } from './tournament-routes.mjs'

test('live tournament counts share a pairing across public and expanded feeds and drop closed viewers', async t => {
  const event = randomUUID(), pair = randomUUID()
  const routes = createTournamentRoutes({
    broadcast: { async live() { return { role: 'spectator', status: 'playing' } } },
    resolveActor: async () => ({ isAdmin: true }),
    send(res, status, data) { res.json = { status, data } },
  })
  t.after(() => routes.stop())
  const origin = 'https://fixture.invalid/api/playtesting/tournaments/'
  const path = event + '/pairings/' + pair + '/watch'
  const req = { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' } }
  function connection() {
    const res = new EventEmitter()
    res.writeHead = () => {}
    res.write = value => { res.payload = JSON.parse(value.split('data: ')[1]); return true }
    res.end = () => res.emit('close')
    return res
  }
  const first = connection(), second = connection(), probe = connection()
  await routes.route(req, probe, new URL(path, origin))
  assert.equal(probe.json.data.spectators, 0)
  await routes.route(req, first, new URL(path + '/events', origin))
  assert.equal(first.payload.spectators, 1)
  await routes.route(req, second, new URL(path + '/events?hands=1', origin))
  assert.equal(second.payload.spectators, 2)
  await routes.route(req, probe, new URL(event + '/pairings/' + randomUUID() + '/watch', origin))
  assert.equal(probe.json.data.spectators, 0)
  await routes.route(req, probe, new URL(path, origin))
  assert.equal(probe.json.data.spectators, 2)
  first.end()
  await routes.route(req, probe, new URL(path, origin))
  assert.equal(probe.json.data.spectators, 1)
})
