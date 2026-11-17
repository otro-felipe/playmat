import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { commandersByPlayer } from '../../core/game/commander';
import { abilityFor, colorChoiceFor, type ManaTap } from '../../core/game/autoPay';
import { planPayment, type PaymentOptions } from '../../core/game/paymentPlan';
import type { GameSession, GameSessionState } from '../../core/game/gameSession';
import type { PlayerBoard } from './boardModel';

const TAP_DELAY_MS = 220;
export type AutoPayOptions = PaymentOptions;

/** Pays one source at a time, waiting for the server after every answer. Explicit requests last one payment only. */
export function useAutoPay(session: GameSession, state: GameSessionState, me: PlayerBoard | null, enabled: boolean, options: AutoPayOptions = {}) {
  const [requested, setRequested] = useState(false);
  const [paused, setPaused] = useState(false);
  const [attempt, setAttempt] = useState<string | null>(null);
  const lastTap = useRef<(ManaTap & { answered?: boolean }) | null>(null);
  const stopped = useRef(false);
  const requestedRef = useRef(false);
  const [xAnnounced, setXAnnounced] = useState(false);
  const { interaction, awaitingServer, view } = state;
  const prompt = interaction.prompt;
  const { hybrid = false, afterX = true, anyColor = false, painful = false } = options;
  const commander = useMemo(() => !!state.playerId && commandersByPlayer(view).has(state.playerId), [view, state.playerId]);
  const plan = useMemo(() => prompt?.kind === 'playMana' && me
    ? planPayment(prompt, me.player, interaction.clickable, Object.values(view?.myHand ?? {}).map((card) => (card.manaCostLeftStr ?? []).join('')), { hybrid, anyColor, painful, commander })
    : null, [prompt, me, interaction.clickable, view, hybrid, anyColor, painful, commander]);
  // A source that adds to the pool without paying changes the signature too: spend that mana on the next step.
  const signature = prompt?.kind === 'playMana' ? `${prompt.message}|${JSON.stringify(me?.player.manaPool ?? {})}` : null;
  const stalled = signature !== null && attempt === signature && !awaitingServer;
  const active = !paused && (enabled || requested) && (!xAnnounced || afterX || requested);
  const busy = active && !stalled && (awaitingServer || !!plan?.next);

  useEffect(() => session.store.subscribe((next, previous) => {
    if (next.interaction === previous.interaction || next.awaitingServer) return;
    const kind = next.interaction.prompt?.kind;
    if (kind === 'amount' && /announce the value for/i.test(next.interaction.prompt!.text)) setXAnnounced(true);
    else if (next.interaction.mode === 'priority') setXAnnounced(false);
    if (kind === 'playMana' || kind === 'chooseAbility' || (kind === 'chooseChoice' && next.interaction.prompt?.kind === 'chooseChoice' && next.interaction.prompt.choice.manaColorChoice)) return;
    requestedRef.current = false;
    stopped.current = false;
    lastTap.current = null;
    setRequested(false);
    setPaused(false);
    setAttempt(null);
  }), [session]);

  const start = useCallback(() => {
    if (requestedRef.current || session.getState().awaitingServer || session.getState().interaction.mode !== 'payMana') return;
    requestedRef.current = true;
    stopped.current = false;
    setAttempt(null);
    setPaused(false);
    setRequested(true);
  }, [session]);
  const stop = useCallback(() => {
    stopped.current = true;
    requestedRef.current = false;
    lastTap.current = null;
    setRequested(false);
    setPaused(true);
  }, []);

  useEffect(() => {
    if (!active || stopped.current || awaitingServer) return;
    if (prompt?.kind === 'chooseAbility' && lastTap.current && !lastTap.current.answered) {
      const ability = abilityFor(prompt.choices, lastTap.current.color);
      lastTap.current = ability ? { ...lastTap.current, answered: true } : null;
      if (ability) void session.respond({ type: 'uuid', id: ability }).catch(() => undefined);
      return;
    }
    if (prompt?.kind === 'chooseChoice' && prompt.choice.manaColorChoice && lastTap.current) {
      const color = colorChoiceFor(prompt.choice.choices ?? [], lastTap.current.color);
      lastTap.current = null;
      if (color) void session.respond({ type: 'string', value: color }).catch(() => undefined);
      return;
    }
    if (interaction.mode !== 'payMana' || !plan?.next || stalled) return;
    lastTap.current = null;
    const tap = plan.next;
    const timer = setTimeout(() => {
      if (stopped.current || session.getState().awaitingServer || session.getState().interaction.prompt !== prompt) return;
      lastTap.current = tap;
      setAttempt(signature);
      session.click(tap.id);
    }, TAP_DELAY_MS);
    return () => clearTimeout(timer);
  }, [active, awaitingServer, interaction.mode, prompt, session, plan, stalled, signature]);

  return { start, stop, busy, available: !!plan?.next && !stalled, reason: stalled ? 'manual' as const : plan?.reason ?? null };
}
