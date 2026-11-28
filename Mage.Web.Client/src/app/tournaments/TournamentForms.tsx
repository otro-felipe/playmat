import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useT } from '../i18n';
import { Button, ButtonLink } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Zone } from '../ui/Zone';
import {
  request,
  tournamentApi,
  tournamentPath,
  type Pairing,
  type Tournament,
  type StructureRange,
  type AdminAction,
} from './tournamentApi';
import styles from './TournamentScreen.module.css';

function Select({
  label,
  value,
  onChange,
  children,
  disabled,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={styles.field}>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        {children}
      </select>
    </label>
  );
}
function Numeric({
  name,
  label,
  value,
  min,
  max,
}: {
  name: string;
  label: string;
  value: number;
  min: number;
  max: number;
}) {
  return (
    <label className={styles.field}>
      {label}
      <input name={name} type="number" min={min} max={max} defaultValue={value} required />
    </label>
  );
}
export function CreateTournamentForm({ close, structures }: { close(): void; structures: StructureRange[] }) {
  const t = useT();
  const navigate = useNavigate();
  const [template, setTemplate] = useState('attendance');
  const [format, setFormat] = useState('Standard');
  const [capacity, setCapacity] = useState(8);
  const [cut, setCut] = useState('none');
  const [automaticRounds, setAutomatic] = useState(true);
  const [swiss, setSwiss] = useState('3');
  const [playoff, setPlayoff] = useState('3');
  const worlds = template === 'worlds';
  const expected = capacity >= 2 ? structures.find((range) => capacity <= range.upTo) : undefined;
  const create = useMutation({
    mutationFn: (body: object) => request<{ id: string }>(tournamentApi, body),
    onSuccess: ({ id }) => navigate(tournamentPath(id) + '/admin'),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    create.mutate({
      name: String(form.get('name')).trim(),
      template,
      format: worlds ? 'Standard' : format,
      cut: worlds ? 'auto' : cut,
      capacity: Number(form.get('capacity')),
      maxAgentsPerOwner: Number(form.get('limit')),
      breakMinutes: Number(form.get('break')),
      coaching: !worlds && form.has('coaching'),
      swissBestOf: Number(swiss),
      playoffBestOf: Number(playoff),
      ...(!worlds && cut === 'none' && !automaticRounds && { swissRounds: Number(form.get('rounds')) }),
    });
  }
  return (
    <form className={styles.form} onSubmit={submit}>
      <label className={styles.field}>
        {t('cup.name')}
        <input name="name" required maxLength={100} autoFocus />
      </label>
      <div className={styles.fields}>
        <Select
          label={t('cup.template')}
          value={template}
          onChange={(value) => {
            setTemplate(value);
            setCapacity(value === 'worlds' ? 128 : 8);
            setSwiss('3');
            setPlayoff(value === 'worlds' ? '5' : '3');
          }}
        >
          <option value="attendance">{t('cup.attendance')}</option>
          <option value="worlds">{t('cup.worlds')}</option>
        </Select>
        <Select label={t('cup.format')} value={worlds ? 'Standard' : format} onChange={setFormat} disabled={worlds}>
          {['Standard', 'Pioneer', 'Modern'].map((option) => (
            <option key={option}>{option}</option>
          ))}
        </Select>
      </div>
      <div className={styles.fields}>
        <label className={styles.field}>
          {t('cup.capacity')}
          <input
            type="number"
            name="capacity"
            min={2}
            max={512}
            required
            value={capacity || ''}
            onChange={(e) => setCapacity(Number(e.target.value))}
          />
        </label>
        <Numeric name="limit" label={t('cup.limit')} min={1} max={capacity || 512} value={4} />
      </div>
      {worlds ? (
        <p>{t('cup.worldHint')}</p>
      ) : (
        <div className={styles.fields}>
          <Select label={t('cup.cut')} value={cut} onChange={setCut}>
            <option value="none">{t('cup.none')}</option>
            <option value="auto">{t('cup.auto')}</option>
          </Select>
          {cut === 'none' && (
            <label className={styles.check}>
              <input type="checkbox" checked={automaticRounds} onChange={(e) => setAutomatic(e.target.checked)} />
              {t('cup.autoRounds')}
            </label>
          )}
        </div>
      )}
      {!worlds &&
        cut === 'none' &&
        (automaticRounds ? (
          expected && <p role="status">{t('cup.roundEstimate', { n: expected.roundsOnly, slots: capacity })}</p>
        ) : (
          <Numeric name="rounds" label={t('cup.rounds')} min={1} max={14} value={expected?.roundsOnly ?? 3} />
        ))}
      {!worlds && cut === 'auto' && expected && (
        <p role="status">
          {expected.swissRounds
            ? t('cup.previewCut', { slots: capacity, rounds: expected.swissRounds, top: expected.cutSize })
            : t('cup.previewElimination', { slots: capacity, rounds: Math.log2(expected.cutSize) })}
        </p>
      )}
      {!worlds && cut === 'none' && <p className={styles.muted}>{t('cup.noneHint')}</p>}
      <div className={styles.fields}>
        {(worlds || cut === 'none' || expected?.swissRounds !== 0) && (
          <Select label={t('cup.swissBest')} value={swiss} onChange={setSwiss}>
            <option value="3">Bo3</option>
            <option value="5">Bo5</option>
          </Select>
        )}
        {(cut === 'auto' || worlds) && (
          <Select label={t('cup.playoffBest')} value={playoff} onChange={setPlayoff}>
            <option value="3">Bo3</option>
            <option value="5">Bo5</option>
          </Select>
        )}
        <Numeric name="break" label={t('cup.breakMinutes')} min={0} max={1440} value={5} />
      </div>
      {!worlds && (
        <label className={styles.check}>
          <input type="checkbox" name="coaching" />
          {t('cup.coaching')}
        </label>
      )}
      {create.error && (
        <p role="alert" className={styles.error}>
          {create.error.message}
        </p>
      )}
      <div className={styles.actions}>
        <Button type="submit" variant="decision" busy={create.isPending}>
          {t('cup.publish')}
        </Button>
        <Button variant="quiet" onClick={close}>
          {t('cup.cancel')}
        </Button>
      </div>
    </form>
  );
}

export function Registration({ cup, refresh }: { cup: Tournament; refresh(): void }) {
  const t = useT();
  const [playerId, setPlayer] = useState('');
  const [deckId, setDeck] = useState('');
  const username = cup.viewer?.accountName ?? cup.viewer?.username ?? '';
  const profiles = useQuery({
    queryKey: ['cup-profiles', username],
    enabled: !!username,
    queryFn: ({ signal }) =>
      request<{ players: { id: string; displayName: string; mcpEnabled: boolean }[] }>(
        '/api/playtesting/players',
        undefined,
        signal,
      ),
  });
  type Decks = { decks: { id: string; name: string; format: string }[] };
  const decks = useQuery({
    queryKey: ['cup-decks', username, playerId],
    enabled: !!username,
    queryFn: async ({ signal }) => {
      const libraries = playerId ? ['private&playerId=' + encodeURIComponent(playerId), 'agent'] : ['personal'];
      const result = await Promise.all(
        libraries.map((library) =>
          request<Decks>('/api/playtesting/decks?library=' + library, undefined, signal, {
            'X-Playmat-Deck-Owner': username,
          }),
        ),
      );
      return result.flatMap((page) => page.decks);
    },
  });
  const join = useMutation({
    mutationFn: (id: string) =>
      request(tournamentApi + '/' + encodeURIComponent(cup.id) + '/join', { deckId: id, ...(playerId && { playerId }) }),
    onSuccess: refresh,
  });
  if (!username)
    return <ButtonLink href={'/login?next=' + encodeURIComponent(tournamentPath(cup.id))}>{t('cup.signIn')}</ButtonLink>;
  const eligible = decks.data?.filter((deck) => deck.format === cup.format) ?? [];
  const selected = eligible.find((deck) => deck.id === deckId)?.id ?? eligible[0]?.id ?? '';
  const existing = cup.participants.some(
    (e) => cup.viewer?.entryIds?.includes(e.id) && (playerId ? e.playerId === playerId : e.kind === 'human'),
  );
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (selected) join.mutate(selected);
      }}
    >
      <div className={styles.fields}>
        <Select
          label={t('cup.participant')}
          value={playerId}
          onChange={(value) => {
            setPlayer(value);
            setDeck('');
            join.reset();
          }}
        >
          <option value="">{t('cup.myself')}</option>
          {profiles.data?.players
            .filter((p) => p.mcpEnabled)
            .map((player) => (
              <option key={player.id} value={player.id}>
                {player.displayName}
              </option>
            ))}
        </Select>
        <Select label={t('cup.deck')} value={selected} onChange={setDeck} disabled={!eligible.length}>
          {!eligible.length && <option value="">{decks.isPending ? '…' : t('cup.noDeck')}</option>}
          {eligible.map((deck) => (
            <option key={deck.id} value={deck.id}>
              {deck.name}
            </option>
          ))}
        </Select>
      </div>
      {[join.error, profiles.error, decks.error].filter(Boolean).map((error, index) => (
        <p key={index} role="alert" className={styles.error}>
          {error?.message}
        </p>
      ))}
      {join.isSuccess && <p role="status">{t('cup.saved')}</p>}
      <div className={styles.actions}>
        <Button type="submit" variant="decision" busy={join.isPending} disabled={!selected}>
          {t(existing ? 'cup.replace' : 'cup.register')}
        </Button>
        <ButtonLink href="/decks" target="_blank" rel="noopener" variant="quiet">
          {t('cup.myDecks')}
        </ButtonLink>
      </div>
    </form>
  );
}

function RetryFailedStart({ cup, candidates, refresh }: { cup: Tournament; candidates: Pairing[]; refresh(): void }) {
  const t = useT();
  const [tableId, setTableId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const selected = candidates.find(p => p.tableId === tableId);
  const retry = useMutation({
    mutationFn: (pairingId: string) => request(tournamentApi + '/' + encodeURIComponent(cup.id) + '/admin', {
      action: 'retryFailedStart', pairingId, tableId, confirmedPreGameFailure: true,
    }),
    onSuccess: () => { setTableId(''); setConfirmed(false); refresh(); },
  });
  return (
    <details>
      <summary>{t('cup.recoverStart')}</summary>
      <form className={styles.form} onSubmit={event => {
        event.preventDefault();
        if (selected && confirmed && !retry.isPending) retry.mutate(selected.id);
      }}>
        <Select label={t('cup.recoverTable')} value={selected ? tableId : ''} disabled={retry.isPending}
          onChange={id => { setTableId(id); setConfirmed(false); retry.reset(); }}>
          <option value="">{t('cup.chooseTable')}</option>
          {candidates.map(p =>
            <option key={p.tableId} value={p.tableId}>
              {t('cup.table', { n: p.number })} · {cup.participants.find(e => e.id === p.a)?.name} / {cup.participants.find(e => e.id === p.b)?.name}
            </option>
          )}
        </Select>
        <label className={styles.check}>
          <input type="checkbox" checked={!!selected && confirmed} disabled={!selected || retry.isPending}
            onChange={event => setConfirmed(event.target.checked)} />
          {t('cup.confirmFailedStart')}
        </label>
        <div><Button type="submit" disabled={!selected || !confirmed} busy={retry.isPending}>{t('cup.retryStart')}</Button></div>
        {retry.isSuccess && <p role="status">{t('cup.recoveryQueued')}</p>}
        {retry.error && <p role="alert" className={styles.error}>{retry.error.message}</p>}
      </form>
    </details>
  );
}

function VoidCompletedTournament({ cup, refresh }: { cup: Tournament; refresh(): void }) {
  const t = useT();
  const client = useQueryClient();
  const trigger = useRef<HTMLButtonElement>(null);
  const requestId = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const action = useMutation({
    mutationFn: (id: string) => request(tournamentApi + '/' + encodeURIComponent(cup.id) + '/void', {
      requestId: id,
      expectedStatus: 'finished',
    }),
    onSuccess: () => {
      setOpen(false);
      refresh();
      for (const queryKey of [['tournament-list'], ['tournament-owner'], ['playtesting-history'],
        ['playtesting-performance'], ['replays'], ['finishedMatches'], ['/api/playtesting/statistics'],
        [tournamentApi + '/' + encodeURIComponent(cup.id) + '/statistics']]) {
        void client.invalidateQueries({ queryKey });
      }
    },
  });
  return <>
    <Button ref={trigger} variant="danger" disabled={action.isSuccess} onClick={() => setOpen(true)}>
      {t('cup.voidTournament')}
    </Button>
    <Dialog open={open} onOpenChange={setOpen} returnFocusRef={trigger} width="sm"
      title={t('cup.confirmVoidTitle')} description={t('cup.confirmVoidDescription')}
      dismissible={!action.isPending} footer={<>
        <Button disabled={action.isPending} onClick={() => setOpen(false)}>{t('cup.cancel')}</Button>
        <Button variant="danger" busy={action.isPending} onClick={() => {
          requestId.current ??= crypto.randomUUID();
          action.mutate(requestId.current);
        }}>{t('cup.confirmVoid')}</Button>
      </>}>
      {action.error && <p role="alert" className={styles.error}>{action.error.message}</p>}
    </Dialog>
  </>;
}

export function AdminControls({ cup, refresh }: { cup: Tournament; refresh(): void }) {
  const t = useT();
  const [when, setWhen] = useState('');
  const [structure, setStructure] = useState(cup.template === 'worlds' ? 'worlds' : cup.cut);
  const admin = useMutation({
    mutationFn: (body: {
      action: AdminAction;
      minutes?: number;
      nextSessionAt?: number;
      template?: string;
      cut?: string;
      swissRounds?: number;
    }) => request(tournamentApi + '/' + encodeURIComponent(cup.id) + '/admin', body),
    onSuccess: refresh,
  });
  const candidates = cup.status === 'playing' ? cup.pairings.filter(
    (p) => p.roundNumber === cup.roundNumber && p.b && p.tableId && !p.completed && !p.matchId,
  ) : [];
  if (cup.status === 'finished') {
    return cup.viewer?.canVoid ? <Zone label={t('cup.admin')}><VoidCompletedTournament key={cup.id} cup={cup} refresh={refresh} /></Zone> : null;
  }
  if (cup.status === 'cancelled' || (cup.status === 'playing' && !candidates.length)) {
    return null;
  }
  return (
    <Zone label={t('cup.admin')}>
      <div className={styles.stack}>
        {candidates.length > 0 && (
          <RetryFailedStart key={cup.id + '/' + cup.roundNumber} cup={cup} candidates={candidates} refresh={refresh} />
        )}
        {cup.status === 'registration' && (
          <div>
            <Button variant="decision" busy={admin.isPending} onClick={() => admin.mutate({ action: 'start' })}>
              {t('cup.start')}
            </Button>
          </div>
        )}
        {cup.status === 'registration' && (
          <details>
            <summary>{t('cup.editStructure')}</summary>
            <form
              className={styles.form}
              onSubmit={(event) => {
                event.preventDefault();
                admin.mutate({
                  action: 'structure',
                  template: structure === 'worlds' ? 'worlds' : 'attendance',
                  cut: structure === 'none' ? 'none' : 'auto',
                  ...(structure === 'none' && { swissRounds: Number(new FormData(event.currentTarget).get('rounds')) }),
                });
              }}
            >
              {cup.template === 'worlds' && cup.participants.filter((e) => e.online).length <= 8 && (
                <p>{t('cup.smallWorlds')}</p>
              )}
              <Select label={t('cup.template')} value={structure} onChange={setStructure}>
                <option value="none">{t('cup.none')}</option>
                <option value="auto">{t('cup.auto')}</option>
                {cup.format === 'Standard' && <option value="worlds">{t('cup.worlds')}</option>}
              </Select>
              {structure === 'none' && (
                <Numeric name="rounds" label={t('cup.rounds')} min={1} max={14} value={cup.roundsTotal || 3} />
              )}
              <div>
                <Button type="submit" busy={admin.isPending}>
                  {t('cup.saveStructure')}
                </Button>
              </div>
            </form>
          </details>
        )}
        {cup.status === 'paused' && (
          <div>
            <Button variant="decision" busy={admin.isPending} onClick={() => admin.mutate({ action: 'resume' })}>
              {t('cup.resume')}
            </Button>
          </div>
        )}
        {cup.status === 'break' && (
          <>
            <form
              className={styles.row}
              onSubmit={(event) => {
                event.preventDefault();
                admin.mutate({ action: 'extend', minutes: Number(new FormData(event.currentTarget).get('minutes')) });
              }}
            >
              <Numeric name="minutes" min={1} max={1440} value={5} label={t('cup.minutes')} />
              <Button type="submit" busy={admin.isPending}>
                {t('cup.extend')}
              </Button>
            </form>
          </>
        )}
        {(cup.status === 'break' || cup.status === 'paused') && (
          <form
            className={styles.row}
            onSubmit={(event) => {
              event.preventDefault();
              admin.mutate({ action: 'pause', ...(when && { nextSessionAt: new Date(when).getTime() }) });
            }}
          >
            <label className={styles.field}>
              {t('cup.nextSession')}
              <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
            </label>
            <Button type="submit" disabled={cup.status === 'paused' && !when} busy={admin.isPending}>
              {t(cup.status === 'paused' ? 'cup.schedule' : 'cup.pause')}
            </Button>
          </form>
        )}
        {admin.error && (
          <p role="alert" className={styles.error}>
            {admin.error.message}
          </p>
        )}
      </div>
    </Zone>
  );
}
