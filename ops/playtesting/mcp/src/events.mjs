import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export function registerEvents(server, actor, request) {
  server.registerCapabilities({ events: {} });
  for (const name of ['list', 'subscribe', 'unsubscribe']) {
    const schema = z.object({
      method: z.literal('events/' + name),
      params: z.record(z.string(), z.unknown()).optional(),
    });
    server.setRequestHandler(schema, async ({ params }) => {
      if (!actor.scopes.includes('play')) {
        if (name === 'list') return { events: [] };
        throw new McpError(-32001, 'A Playmat play seat is required.');
      }
      return request(name, params ?? {});
    });
  }
}

function currentDecision(snapshot) {
  const { gameId, cursor, decision, sideboard, status, secondsRemaining } = snapshot;
  if (!gameId || !Number.isSafeInteger(cursor)) return null;
  if (status === 'sideboarding' && sideboard?.decisionId && !sideboard.submitted) {
    return { gameId, cursor, decisionId: sideboard.decisionId, kind: 'sideboarding', secondsRemaining };
  }
  if (status !== 'active' || selectionMissing(decision)) return null;
  return { gameId, cursor, decisionId: decision.id, kind: decision.kind, secondsRemaining };
}

function selectionMissing(decision) {
  return !decision?.id || decision.kind === 'waiting' || !decision.choices?.length;
}

export function monitorSeatDecisions(engine, actor, publish) {
  const { accountId, engineName } = actor;
  const name = 'game.decision.required';
  let desired = null;
  let published = null;
  let running = false;
  let stopped = false;
  let retry;

  async function flush() {
    if (running || stopped) return;
    running = true;
    try {
      while (!stopped && published?.key !== desired?.key) {
        if (published) {
          await publish('invalidate', { accountId, engineName, name, key: published.key });
          published = null;
        }
        const next = desired;
        if (!stopped && next && next.expiresAt > Date.now()) {
          await publish('enqueue', { accountId, engineName, name, ...next });
          published = next;
        } else if (desired === next) {
          desired = null;
        }
      }
    } catch {
      if (!stopped && !retry) {
        retry = setTimeout(() => { retry = undefined; void flush(); }, 500);
        retry.unref?.();
      }
    } finally {
      running = false;
    }
  }

  function update() {
    let decision;
    try { decision = currentDecision(engine.snapshot()); }
    catch { return; }
    const key = decision ? decision.gameId + ':' + decision.decisionId : null;
    if (key === (desired?.key ?? null)) return;
    if (decision) {
      const { secondsRemaining, ...data } = decision;
      const lifetime = secondsRemaining > 0 ? Math.min(25, secondsRemaining) : 25;
      desired = { key, data, expiresAt: Date.now() + lifetime * 1000 };
    } else {
      desired = null;
    }
    void flush();
  }
  const unsubscribe = engine.subscribe(update);
  update();
  return () => {
    stopped = true;
    clearTimeout(retry);
    unsubscribe();
  };
}
