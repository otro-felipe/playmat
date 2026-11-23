import { ChevronDown } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import {
  ATTACK_OPTIONS, BUFFER_TIMES, DEFAULT_ADVANCED, MULLIGAN_TYPES, parseSeed, RANGES, SKILL_LEVELS, TIME_LIMITS, type TableAdvanced,
} from '../../core/game/tableSetup';
import { useT } from '../i18n';
import { Switch } from '../ui/Switch';
import styles from './TableAdvancedFields.module.css';

function Select<T extends string | number>({ label, value, options, onChange, hint }: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
  hint?: ReactNode;
}) {
  const id = useId();
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={String(value)}
        onChange={(event) => {
          const picked = options.find((option) => String(option.value) === event.target.value);
          if (picked) onChange(picked.value);
        }}
      >
        {options.map((option) => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
      </select>
      {hint && <p className={styles.hint}>{hint}</p>}
    </div>
  );
}

function SeedField({ value, onChange }: { value: string; onChange(value: string): void }) {
  const id = useId();
  const t = useT();
  const invalid = value.trim() !== '' && parseSeed(value) === null;
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{t('hostTable.seed')}</label>
      <input
        id={id}
        inputMode="numeric"
        placeholder={t('hostTable.random')}
        value={value}
        aria-invalid={invalid}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className={styles.hint}>{t(invalid ? 'hostTable.seedInvalid' : 'hostTable.seedHint')}</p>
    </div>
  );
}

/** The host dialog's "Advanced" section: closed by default, with a one-line summary of what was changed. */
export function TableAdvancedFields({ value, onChange, multiplayer, commander }: {
  value: TableAdvanced;
  onChange(patch: Partial<TableAdvanced>): void;
  multiplayer: boolean;
  commander: boolean;
}) {
  const [open, setOpen] = useState(false);
  const t = useT();
  const bodyId = useId();
  const formatDefault = t('hostTable.formatDefault');
  const none = t('hostTable.none');
  const numericOptions = (values: readonly number[]) => values.map(n => ({value: n, label: String(n)}));
  const lives = [{value: 0, label: formatDefault}, ...numericOptions([10, 20, 25, 30, 40, 50, 60])];
  const hands = [{value: 0, label: t('hostTable.seven')}, ...numericOptions([4, 5, 6, 8, 9, 10])];
  const free = [{value: 0, label: none}, ...numericOptions([1, 2, 3])];
  const power = [{value: 0, label: t('hostTable.any')}, ...numericOptions([1,2,3,4,5,6,7,8,9,10]).map(
    option => ({...option, label: t('hostTable.upTo', {count: option.value})}))];
  const ratings = [{value: 0, label: t('hostTable.anyone')}, ...numericOptions([1000,1200,1400,1600,1800]).map(
    option => ({...option, label: option.label+'+'}))];
  const mulligans = MULLIGAN_TYPES.map(option => ({...option, label: option.value === 'GAME_DEFAULT'
    ? formatDefault : option.value === 'SMOOTHED_LONDON' ? t('hostTable.smoothedLondon') : option.label}));
  const clocks = TIME_LIMITS.map(option => ({...option, label: option.value === 'NONE' ? t('hostTable.unlimited')
    : t('hostTable.minutes', {count: Number(option.value.slice(3).replaceAll('_', ''))})}));
  const buffers = BUFFER_TIMES.map(option => ({...option, label: option.value === 'NONE' ? none : option.label}));
  const skills = SKILL_LEVELS.map(option => ({...option, label: option.value === 'CASUAL' ? t('ai.rules.casual')
    : t(option.value === 'BEGINNER' ? 'hostTable.beginner' : 'hostTable.serious')}));
  const attacks = ATTACK_OPTIONS.map(option => ({...option,
    label: t(({MULTIPLE:'hostTable.anyone', LEFT:'hostTable.left', RIGHT:'hostTable.right'} as const)[option.value]),
    detail: t(({MULTIPLE:'hostTable.attackMultiple', LEFT:'hostTable.attackLeft', RIGHT:'hostTable.attackRight'} as const)[option.value])}));
  const ranges = RANGES.map(option => ({...option,
    label: t(({ALL:'hostTable.wholeTable', ONE:'hostTable.neighbours', TWO:'hostTable.twoSeats'} as const)[option.value]),
    detail: t(({ALL:'hostTable.rangeAll', ONE:'hostTable.rangeOne', TWO:'hostTable.rangeTwo'} as const)[option.value])}));
  const optionLabel = <T,>(options: {value:T; label:string}[], selected:T) => options.find(option => option.value === selected)?.label;
  const summary: Partial<Record<keyof TableAdvanced,string | undefined>> = {
    mulliganType: optionLabel(mulligans,value.mulliganType),
    seed: parseSeed(value.seed) === null ? undefined : t('hostTable.seed')+' '+value.seed.trim(),
    freeMulligans: t('hostTable.freeMulligans')+' '+value.freeMulligans,
    matchTimeLimit: optionLabel(clocks,value.matchTimeLimit), matchBufferTime: optionLabel(buffers,value.matchBufferTime),
    rated: t('hostTable.rated'), planeChase: 'Planechase', startingLife: t('ai.summary.life',{count: value.startingLife ?? 0}),
    handSize: t('hostTable.openingHand')+' '+value.handSize, skillLevel: optionLabel(skills,value.skillLevel),
    minimumRating: t('hostTable.rating')+' '+value.minimumRating,
    edhPowerLevel: commander ? t('hostTable.power')+' '+value.edhPowerLevel : undefined,
    attackOption: multiplayer ? optionLabel(attacks,value.attackOption) : undefined,
    range: multiplayer ? optionLabel(ranges,value.range) : undefined,
    spectatorsAllowed: t('hostTable.noSpectators'),
  };
  const changed = (Object.keys(summary) as (keyof TableAdvanced)[])
    .filter(key => value[key] !== DEFAULT_ADVANCED[key]).map(key => summary[key]).filter(Boolean);
  return (
    <section className={styles.advanced}>
      <button type="button" className={styles.toggle} aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
        <ChevronDown size={16} className={open ? styles.chevronOpen : styles.chevron} aria-hidden="true" />
        {t('hostTable.advanced')}
        <span className={styles.summary}>{changed.length > 0 ? changed.join(' · ') : t('hostTable.standardRules')}</span>
      </button>
      {open && (
        <div id={bodyId} className={styles.grid}>
          <Select label="Mulligan" value={value.mulliganType} options={mulligans} onChange={(mulliganType) => onChange({ mulliganType })} />
          <Select label={t('hostTable.freeMulligans')} value={value.freeMulligans} options={free} onChange={(freeMulligans) => onChange({ freeMulligans })} />
          <Select label={t('ai.life')} value={value.startingLife ?? 0} options={lives} onChange={(life) => onChange({ startingLife: life === 0 ? null : life })} />
          <Select label={t('hostTable.openingHand')} value={value.handSize ?? 0} options={hands} onChange={(size) => onChange({ handSize: size === 0 ? null : size })} />
          <Select label={t('hostTable.clock')} value={value.matchTimeLimit} options={clocks} onChange={(matchTimeLimit) => onChange({ matchTimeLimit })} hint={t('hostTable.clockHint')} />
          <Select label={t('hostTable.buffer')} value={value.matchBufferTime} options={buffers} onChange={(matchBufferTime) => onChange({ matchBufferTime })} hint={t('hostTable.bufferHint')} />
          <Select label={t('hostTable.skill')} value={value.skillLevel} options={skills} onChange={(skillLevel) => onChange({ skillLevel })} />
          <SeedField value={value.seed} onChange={(seed) => onChange({ seed })} />
          <Select label={t('hostTable.rating')} value={value.minimumRating} options={ratings} onChange={(minimumRating) => onChange({ minimumRating })} />
          {commander && (
            <Select label={t('hostTable.power')} value={value.edhPowerLevel} options={power} onChange={(edhPowerLevel) => onChange({ edhPowerLevel })} hint={t('hostTable.powerHint')} />
          )}
          {multiplayer && (
            <>
              <Select
                label={t('hostTable.attack')}
                value={value.attackOption}
                options={attacks}
                onChange={(attackOption) => onChange({ attackOption })}
                hint={attacks.find((option) => option.value === value.attackOption)?.detail}
              />
              <Select
                label={t('hostTable.range')}
                value={value.range}
                options={ranges}
                onChange={(range) => onChange({ range })}
                hint={ranges.find((option) => option.value === value.range)?.detail}
              />
            </>
          )}
          <div className={styles.checks}>
            <Switch label={t('hostTable.rated')} checked={value.rated} onCheckedChange={(rated) => onChange({ rated })} />
            <Switch label="Planechase" checked={value.planeChase} onCheckedChange={(planeChase) => onChange({ planeChase })} />
            <Switch label={t('hostTable.spectators')} checked={value.spectatorsAllowed} onCheckedChange={(spectatorsAllowed) => onChange({ spectatorsAllowed })} />
            <Switch label={t('hostTable.rollback')} checked={value.rollbackTurnsAllowed} onCheckedChange={(rollbackTurnsAllowed) => onChange({ rollbackTurnsAllowed })} />
          </div>
        </div>
      )}
    </section>
  );
}
