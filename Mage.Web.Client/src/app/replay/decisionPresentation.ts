import { parseLogHtml, segmentsText } from '../../core/game/gameLog';
import type { MessageKey, Translate } from '../i18n';
import type { ReviewMoment, ReviewReference } from './reviewData';

const actionTitles: Partial<Record<string, MessageKey>> = {
  cast: 'replay.action.cast',
  land: 'replay.action.land',
  activate: 'replay.action.activate',
  attack: 'replay.action.attack',
  block: 'replay.action.block',
  discard: 'replay.action.discard',
  select: 'replay.action.select',
};

const cardlessTitles: Partial<Record<string, MessageKey>> = {
  keep: 'replay.action.keep',
  mulligan: 'replay.action.mulligan',
  attack: 'replay.action.declareAttackers',
  block: 'replay.action.declareBlockers',
  pass: 'replay.action.pass',
  omission: 'replay.action.omission',
};

const directedTitles: Partial<Record<string, MessageKey>> = {
  attack: 'replay.action.attackAt',
  block: 'replay.action.blockWhat',
};

export function replayName(name: string, t: Translate) {
  return /^mcp_[a-f0-9]+$/i.test(name) ? t('replay.agent') : name;
}

export function cleanDecisionText(text: string, t: Translate) {
  return segmentsText(parseLogHtml(text))
    .replace(/\bmcp_[a-f0-9]+\b/gi, t('replay.agent'))
    .replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function decisionPresentation(moment: ReviewMoment, t: Translate) {
  const { actual } = moment;
  const card = actual?.cardRef ?? (actual?.card ? { name: actual.card } : null);
  const targets = (actual?.targets ?? []).map((target) => target.kind === 'player'
    ? { ...target, name: replayName(target.name, t) } : target);
  const actingName = moment.decisionActor ?? moment.actor;
  const actor = actingName ? replayName(actingName, t) : t('replay.player');
  const window = actual?.kind === 'omission' ? moment.evidence?.window : undefined;
  const titleKey = window === 'before_combat' ? 'replay.action.omissionCombat'
    : window === 'before_end_turn' ? 'replay.action.omissionEndTurn'
      : actual && (card ? actionTitles[actual.kind] : cardlessTitles[actual.kind]);
  const directedKey = actual && card && targets.length ? directedTitles[actual.kind] : undefined;
  const targetNames = targets.map(({ name }) => name).join(', ');
  const title = titleKey
    ? t(directedKey ?? titleKey, { actor, ...(card ? { card: card.name } : {}), ...(directedKey ? { targets: targetNames } : {}) })
    : cleanDecisionText(moment.text ?? actual?.text ?? '', t) || t('replay.decision');
  const targetPart = titleKey && !directedKey && targetNames ? ` ${t('replay.action.targets', { targets: targetNames })}` : '';
  const source = actual?.sourceCardRef;
  const causePart = titleKey && source ? ` ${t('replay.action.causedBy', { source: source.name })}` : '';
  const fullTitle = title + targetPart + causePart;
  const shortTitle = titleKey && directedKey ? t(titleKey, { actor, card: card?.name ?? '' }) : title;
  const cards: ReviewReference[] = [card, source, ...targets.filter(({ kind }) => kind !== 'player')]
    .flatMap((ref) => ref ? [ref] : []);
  return { fullTitle, shortTitle: shortTitle + causePart, cards, targets };
}

/** Bridge older notes and newly recorded actions without replacing the pre-action evidence cursor. */
export function decisionFrame(moment: Pick<ReviewMoment, 'cursor' | 'frameCursor' | 'actionFrameCursor'>) {
  return moment.actionFrameCursor ?? moment.frameCursor ?? moment.cursor;
}
