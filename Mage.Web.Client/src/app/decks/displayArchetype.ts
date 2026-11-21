import type { Translate } from '../i18n';

export function displayArchetype(t: Translate, label?: string | null): string {
  switch (label) {
    case undefined:
    case null:
    case '':
      return t('perf.unclassified');
    case 'Empty deck':
      return t('decks.emptyArchetype');
    case 'Creature Practice':
      return t('decks.creaturePracticeArchetype');
    case 'Basic Lands Practice':
      return t('decks.basicLandsArchetype');
    case 'Other':
      return t('decks.otherArchetype');
    default:
      return label;
  }
}
