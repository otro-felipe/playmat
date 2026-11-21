import { archetypesFor, classifyArchetype } from '../../core/decks/archetypes/library.mjs';
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
  const selected = archetype && options.includes(archetype) ? archetype : classifyArchetype(format, name);
  return (
    <label className={styles.archetype}>
      <span className={styles.label}>{t('decks.archetype')}</span>
      <select required value={selected} onChange={event => onChange(event.target.value)}>
        {options.map(label => <option key={label} value={label}>{label === 'Other' ? t('decks.otherArchetype') : label}</option>)}
      </select>
    </label>
  );
}
