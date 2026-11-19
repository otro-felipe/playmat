import type { CardView, GameView } from '../../protocol/generated/views';

export const reviewCategories = ['brilliant', 'best', 'good', 'acceptable', 'inaccuracy', 'blunder', 'equivalent', 'insufficient', 'unrated'] as const;
export type ReviewCategory = typeof reviewCategories[number];
export type ReviewCounts = Partial<Record<ReviewCategory, number>>;
export type ReviewCoverage = Record<string, string | number | boolean | { status?: string; recorded?: number; total?: number }>;

export interface ReviewSummary {
  status: 'not_started' | 'partial' | 'complete' | 'unavailable';
  eligible: number | null;
  reviewed: number;
  counts: ReviewCounts;
  bySeat?: { seatId: string; name?: string; reviewed?: number; counts: ReviewCounts }[];
}

export interface ReplayPerspective {
  seatId: string;
  playerId?: string;
  allowed?: boolean;
  name: string;
  owned?: boolean;
}

interface DeckChange {
  name: string;
  amount: number;
}

export type SideboardDelta = {
  status: 'available';
  fromGameNumber: number;
  toGameNumber: number;
  broughtIn: DeckChange[];
  tookOut: DeckChange[];
} | { status: 'initial_game' | 'unavailable' };

export interface ReviewManifest {
  gameId: string;
  matchId: string;
  gameNumber: number;
  status: string;
  viewerSeatId?: string;
  availablePerspectives?: ReplayPerspective[];
  fullAvailable?: boolean;
  coverage?: ReviewCoverage;
  archiveRevision?: string;
  analysis?: ReviewSummary;
  sideboardDelta?: SideboardDelta;
  privacy?: {
    fullAvailable?: boolean;
    viewerSeatId?: string;
    perspectives?: ReplayPerspective[];
    reason?: string;
  };
}

export type ReplayHands = Record<string, Record<string, CardView>>;

export interface ReviewReference {
  id?: string;
  name: string;
  kind?: 'card' | 'player';
  setCode?: string;
  cardNumber?: string;
}

export interface ReviewAction {
  kind: string;
  text: string;
  card?: string;
  cardRef?: ReviewReference;
  sourceCardRef?: ReviewReference;
  targets?: ReviewReference[];
  targetIds?: string[];
  modes?: string[];
  castMode?: string;
  paidMana?: Record<string, number>;
}

export interface ReviewDecisionContext {
  cards?: ReviewReference[];
  selectedId?: string;
  selectedIds?: string[];
  passKind?: 'manual' | 'automatic';
  stackSize?: number;
  endsTurn?: boolean;
  manaPool?: number;
  availableManaSources?: number;
  playableCount?: number;
  handKind?: 'opening_choice' | 'kept_hand';
  prompt?: string;
  options?: string[];
}

interface ReviewEvidence {
  basis: string;
  frameCursor?: number;
  turn?: number;
  observation?: string;
  window?: 'before_combat' | 'before_end_turn';
}

export interface ReviewMoment {
  cursor: number;
  frameCursor?: number | null;
  actionFrameCursor?: number | null;
  turn?: number;
  text?: string;
  actor?: string;
  seatId?: string;
  decisionActor?: string;
  decisionSeatId?: string;
  actual?: ReviewAction;
  evidence?: ReviewEvidence;
  category?: ReviewCategory;
}

export interface ReviewEvent extends ReviewMoment {
  type?: string;
  actorPlayerId?: string;
  decision?: ReviewDecisionContext;
  card?: { id?: string; name?: string };
  view?: GameView;
  myHand?: Record<string, CardView> | null;
  hands?: ReplayHands;
  log?: { message?: string };
}

export interface ReviewAnnotation extends Pick<ReviewMoment, 'decisionActor' | 'decisionSeatId'> {
  cursor: number;
  frameCursor: number;
  seatId: string;
  category: ReviewCategory;
  actual: ReviewAction;
  rationale?: string;
  benefit?: string;
  risk?: string;
  confidence: 'low' | 'medium' | 'high';
  evidence?: ReviewEvidence;
  alternatives: { line: string; legality: string; condition?: string; benefit?: string; risk?: string }[];
  opponentResponses?: { line: string; basis: string; impact?: string }[];
  sources?: { url: string; date?: string; format?: string; applicability?: string }[];
  theoryStudies?: { studyId: string; tool: 'get_theory_study' }[];
  retrospective?: string | { text?: string; observation?: string };
}

interface EvidencePage {
  events: ReviewEvent[];
  next: number | null;
}

export interface ReviewAnnotationPage {
  annotations: ReviewAnnotation[];
  next: number | null;
}

const reviewPath = (gameId: string) => '/api/playtesting/review/games/' + encodeURIComponent(gameId);

async function request<T>(path: string, signal: AbortSignal, allowUnavailable = false): Promise<T | null> {
  const response = await fetch(path, { signal, cache: 'no-store' });
  if (allowUnavailable && [401, 403, 404].includes(response.status)) return null;
  if (!response.ok) throw new Error('Replay review request failed.');
  return response.json() as Promise<T>;
}

export function loadReviewManifest(gameId: string, signal: AbortSignal) {
  return request<ReviewManifest>(reviewPath(gameId), signal, true);
}

export function loadReviewEvents(gameId: string, cursor: number, scope: 'public' | 'seat' | 'full', count: number, signal: AbortSignal, seatId?: string) {
  const query = new URLSearchParams({ cursor: String(cursor), count: String(count), scope });
  if (seatId) query.set('seatId', seatId);
  return request<EvidencePage>(reviewPath(gameId) + '/evidence?' + query, signal);
}

export function loadReviewPlays(gameId: string, cursor: number, signal: AbortSignal, count = 40) {
  const query = new URLSearchParams({ cursor: String(cursor), count: String(count), scope: 'public', purpose: 'analysis', includeBefore: 'false' });
  return request<EvidencePage>(reviewPath(gameId) + '/evidence?' + query, signal);
}

export function loadReviewAnnotations(gameId: string, cursor: number, signal: AbortSignal) {
  const query = new URLSearchParams({ cursor: String(cursor), count: '32' });
  return request<ReviewAnnotationPage>(reviewPath(gameId) + '/annotations?' + query, signal);
}

export function perspectivesFor(manifest: ReviewManifest | null | undefined): ReplayPerspective[] {
  return manifest?.availablePerspectives?.filter(({ allowed }) => allowed !== false)
    ?? (manifest?.privacy?.perspectives ?? []).filter(({ owned }) => owned || manifest?.privacy?.fullAvailable);
}

export function frameProjection(
  view: GameView,
  playerId: string | null,
  ownReplayHand: Record<string, CardView> | null,
  privateFrame: ReviewEvent | undefined,
  bothHands: boolean,
): { view: GameView; hands?: ReplayHands } {
  const publicView = { ...(privateFrame?.view ?? view) };
  delete publicView.myHand;
  delete publicView.watchedHands;
  const hands = bothHands ? privateFrame?.hands : undefined;
  const archivedHand = bothHands ? (playerId ? hands?.[playerId] : null) : privateFrame?.myHand ?? privateFrame?.view?.myHand;
  const hand = archivedHand ?? ownReplayHand;
  return { view: { ...publicView, myPlayerId: playerId ?? undefined, ...(hand ? { myHand: hand } : {}) }, hands };
}

export function safePublicSource(raw: string): string | null {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
