import type { GameView } from '../../protocol/generated/views';
import type { GameSession, GameSessionState } from './gameSession';
import { publicCardName, publicTargetLabels } from './publicTargets';

export const ACTION_BEAT_MS = 900;
export const MAX_ACTION_PREVIEWS = 8;

export interface ActionPreview {
  key: number;
  objectId: string;
  kind: 'On the stack' | 'Targets announced' | 'Left the stack' | 'Entered the battlefield';
  name: string;
  targets: readonly string[];
  turn: number | undefined;
}

export interface ActionPresentationState {
  items: readonly ActionPreview[];
  /** Explicitly account for bursts too large to preview individually. The game log remains the history. */
  overflow: number;
}

/**
 * Receipts, never a delayed game board. Observe the store directly so React batching cannot swallow a cast
 * followed by a resolution. No game view, prompt, clock or command passes through this queue.
 */
export class ActionPresentation {
  private state: ActionPresentationState = { items: [], overflow: 0 };
  private readonly listeners = new Set<() => void>();
  private previous: GameView | null = null;
  private rebaseFrom: GameView | null | undefined;
  private revision = 0;
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stop: (() => void) | undefined;

  connect(session: GameSession): void {
    this.stop?.();
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.state.items.length || this.state.overflow) this.publish({ items: [], overflow: 0 });
    this.previous = session.getState().view;
    this.rebaseFrom = undefined;
    this.revision = session.getState().rollbackRevision;
    this.stop = session.store.subscribe((state) => this.observe(state));
  }

  getSnapshot = (): ActionPresentationState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  dispose(): void {
    this.stop?.();
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private publish(state: ActionPresentationState): void {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }

  private observe(state: GameSessionState): void {
    const before = this.previous;
    const view = state.view;
    if (state.resyncing || state.gameOver || state.rollbackRevision !== this.revision) {
      this.revision = state.rollbackRevision;
      this.previous = null;
      this.rebaseFrom = view;
      clearTimeout(this.timer);
      this.timer = undefined;
      if (this.state.items.length || this.state.overflow) this.publish({ items: [], overflow: 0 });
      return;
    }
    // Resync clears its flag before replacing the old view. Wait for the actual replacement as our baseline.
    if (this.rebaseFrom !== undefined) {
      if (view === this.rebaseFrom) return;
      this.rebaseFrom = undefined;
      this.previous = view;
      return;
    }
    this.previous = view;
    if (!before || !view || view === before) return;
    const actions: Omit<ActionPreview, 'key'>[] = [];
    for (const [id, card] of Object.entries(view.stack ?? {})) {
      const old = before.stack?.[id];
      const kind = !old ? 'On the stack' : (old.targets ?? []).join() !== (card.targets ?? []).join() ? 'Targets announced' : null;
      if (kind) actions.push({ objectId: id, kind, name: publicCardName(card), targets: publicTargetLabels(card, view), turn: view.turn });
    }
    for (const [id, card] of Object.entries(before.stack ?? {})) {
      if (!view.stack?.[id]) actions.push({ objectId: id, kind: 'Left the stack', name: publicCardName(card), targets: publicTargetLabels(card, before), turn: before.turn });
    }
    const known = new Set((before.players ?? []).flatMap((player) => Object.keys(player.battlefield ?? {})));
    for (const player of view.players ?? []) {
      for (const [id, card] of Object.entries(player.battlefield ?? {})) {
        if (!known.has(id)) actions.push({ objectId: id, kind: 'Entered the battlefield', name: publicCardName(card), targets: [], turn: view.turn });
      }
    }
    if (!actions.length) return;
    const room = this.state.overflow ? 0 : MAX_ACTION_PREVIEWS - this.state.items.length;
    this.publish({
      items: [...this.state.items, ...actions.slice(0, room).map((action) => ({ ...action, key: ++this.seq }))],
      overflow: this.state.overflow + Math.max(0, actions.length - room),
    });
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.state.items.length) this.publish({ ...this.state, items: this.state.items.slice(1) });
      else this.publish({ items: [], overflow: 0 });
      if (this.state.items.length || this.state.overflow) this.schedule();
    }, ACTION_BEAT_MS);
  }
}
