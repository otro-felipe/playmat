import { displayArchetype } from './displayArchetype';
import { archetypesFor, canonicalArchetype, classifyArchetype } from '../../core/decks/archetypes/library.mjs';
import { useT } from '../i18n';
import styles from './DeckShelf.module.css';

interface Props {
  format?: string;
  archetype?: string;
  name?: string;
  onChange(value: string): void;
}

export function ArchetypeSelect({ format, archetype, name, onChange }: Props) {
  const t = useT();
  const options = archetypesFor(format);
  // A deck saved before a catalog change shows its current name (Pioneer: MTGTop8).
  const current = archetype ? canonicalArchetype(format, archetype) : undefined;
  const selected = current && options.includes(current) ? current : classifyArchetype(format, name);
  return (
    <label className={styles.archetype}>
      <span className={styles.label}>{t('decks.archetype')}</span>
      <select required value={selected} onChange={event => onChange(event.target.value)}>
        {options.map(label => <option key={label} value={label}>{displayArchetype(t, label)}</option>)}
      </select>
    </label>
  );
}
