import { createContext, useContext } from 'react';
import type { CardView, GameView, PlayerView } from '../../protocol/generated/views';

interface ExilePresentation {
  bySource: Map<string, CardView[]>;
  byPlayer: Map<string, CardView[]>;
  byOwner: Map<string, CardView[]>;
  sourceNames: Map<string, string>;
  permittedPlayers: Map<string, PlayerView[]>;
}

export type ExileSelection = { sourceId: string } | { playerId: string } | { ownerId: string };

const emptyExile = { bySource: new Map(), byPlayer: new Map(), byOwner: new Map(), sourceNames: new Map(), permittedPlayers: new Map() };
export const ExilePresentationContext = createContext<ExilePresentation>(emptyExile);

function append<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

/** Resolve annotations against the current visible board, never card identities from a previous frame. */
export function presentExile(view: GameView | null): ExilePresentation {
  if (!view) return emptyExile;
  const data: ExilePresentation = { bySource: new Map(), byPlayer: new Map(), byOwner: new Map(), sourceNames: new Map(), permittedPlayers: new Map() };
  const players = new Map<string, PlayerView>();
  const permanents = new Map<string, CardView>();
  const exile = new Map<string, CardView>();
  for (const player of view.players ?? []) {
    if (player.playerId) {
      players.set(player.playerId, player);
      data.byOwner.set(player.playerId, Object.values(player.exile ?? {}));
    }
    for (const card of Object.values(player.battlefield ?? {})) {
      if (card.id && !card.faceDown && !card.hideInfo) permanents.set(card.id, card);
    }
    for (const card of Object.values(player.exile ?? {})) {
      if (card.id && !card.faceDown && !card.hideInfo) exile.set(card.id, card);
    }
  }
  for (const { cardId, sourceId, playableBy } of view.exilePresentation ?? []) {
    const card = cardId ? exile.get(cardId) : undefined;
    if (!cardId || !card) continue;
    if (sourceId) {
      const source = permanents.get(sourceId);
      if (source?.name) {
        append(data.bySource, sourceId, card);
        data.sourceNames.set(cardId, source.name);
      }
    }
    for (const id of playableBy ?? []) {
      const player = players.get(id);
      if (player) {
        append(data.byPlayer, id, card);
        append(data.permittedPlayers, cardId, player);
      }
    }
  }
  return data;
}

export function useExilePresentation() {
  return useContext(ExilePresentationContext);
}

export function selectedExile(data: ExilePresentation, selection: ExileSelection): CardView[] {
  if ('sourceId' in selection) return data.bySource.get(selection.sourceId) ?? [];
  if ('playerId' in selection) return data.byPlayer.get(selection.playerId) ?? [];
  return data.byOwner.get(selection.ownerId) ?? [];
}
