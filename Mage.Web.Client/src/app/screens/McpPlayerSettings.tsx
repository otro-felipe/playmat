import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useRef, useState, type RefObject } from 'react';
import { useT } from '../i18n';
import { getMcpPlayers, PlayerRequestError, removeMcpPlayer, saveMcpPlayer, type McpPlayer, type PlayerSettings } from '../mcp/playerApi';
import { Flag } from '../social/Avatar';
import { useSession } from '../stores/session';
import { AgentModelLabel } from '../ui/AgentModelLabel';
import { providerNames, type AgentProvider } from '../ui/agentModel';
import { Button, IconButton } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Field } from '../ui/Field';
import fieldStyles from '../ui/Field.module.css';
import { refreshPlayerIdentity } from '../ui/usePlayerIdentity';
import { Switch } from '../ui/Switch';
import styles from './SettingsDialog.module.css';

type Action = { kind: 'create' } | { kind: 'edit' | 'remove'; player: McpPlayer };

function busy(player: McpPlayer) {
  return player.availability === 'reserved' || player.availability === 'occupied';
}

export function McpPlayerSettings() {
  const user = useSession(state => state.userName);
  return <AccountPlayers key={user} user={user} />;
}

function AccountPlayers({ user }: { user: string }) {
  const t = useT();
  const client = useQueryClient();
  const key = ['mcp-players', user];
  const list = useQuery({ queryKey: key, queryFn: ({ signal }) => getMcpPlayers(signal), retry: false });
  const [action, setAction] = useState<Action | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const add = useRef<HTMLButtonElement>(null);
  function open(next: Action, button: HTMLElement) {
    trigger.current = button;
    setAction(next);
  }

  return <>
    <section className={styles.accountSection}>
      <p>{t('settings.mcp.library')}</p>
      <div className={styles.accountActions}><Button ref={add} size="sm" icon={<Plus size={16} />} onClick={event => open({ kind: 'create' }, event.currentTarget)}>{t('settings.mcp.add')}</Button></div>
    </section>
    {list.isPending && <p role="status">{t('settings.mcp.loading')}</p>}
    {list.isError && <div className={styles.accountSection}>
      <p role="alert">{t('settings.mcp.loadError')}</p>
      <div><Button size="sm" busy={list.isFetching} onClick={() => void list.refetch()}>{t('watch.retry')}</Button></div>
    </div>}
    {list.data?.length === 0 && <p>{t('settings.mcp.empty')}</p>}
    {!!list.data?.length && <ul className={styles.playerList}>
      {list.data.map(player => <li key={player.playerId} className={styles.row}>
        <div className={styles.playerIdentity}>
          <strong><Flag flagName={player.flag} /> <span>{player.displayName}</span></strong>
          <AgentModelLabel {...player} />
          <span className={styles.rowDetail}>{t(`settings.mcp.${player.availability}`)}</span>
        </div>
        <div className={styles.accountActions}>
          <IconButton label={t('settings.mcp.edit', { name: player.displayName })} icon={<Pencil size={17} />} onClick={event => open({ kind: 'edit', player }, event.currentTarget)} />
          <IconButton label={t('settings.mcp.remove', { name: player.displayName })} icon={<Trash2 size={17} />} disabled={busy(player)} onClick={event => open({ kind: 'remove', player }, event.currentTarget)} />
        </div>
      </li>)}
    </ul>}
    {action && <PlayerAction action={action} returnFocusRef={trigger} onClose={() => setAction(null)} onRefresh={() => void client.invalidateQueries({ queryKey: key })}
      onSaved={result => {
        const id = action.kind === 'remove' ? action.player.playerId : result?.playerId;
        client.setQueryData<McpPlayer[]>(key, previous => {
          if (!previous) return undefined;
          const remaining = previous.filter(player => player.playerId !== id);
          if (result) remaining.push(result);
          return remaining.sort((a, b) => a.displayName.localeCompare(b.displayName));
        });
        const seat = action.kind === 'remove' ? action.player : result;
        if (seat) void refreshPlayerIdentity(seat.engineName);
        if (action.kind === 'remove') trigger.current = add.current;
        setAction(null);
        void client.invalidateQueries({ queryKey: key });
      }} />}
  </>;
}

function PlayerAction({ action, returnFocusRef, onClose, onSaved, onRefresh }: {
  action: Action; returnFocusRef: RefObject<HTMLElement | null>; onClose(): void; onSaved(result: McpPlayer | void): void; onRefresh(): void;
}) {
  const t = useT();
  const player = action.kind === 'create' ? null : action.player;
  const [name, setName] = useState(player?.displayName ?? '');
  const [flag, setFlag] = useState(player?.flag ?? '');
  const [provider, setProvider] = useState<AgentProvider | ''>(player?.provider ?? '');
  const [model, setModel] = useState(player?.model ?? '');
  const [reasoningEffort, setReasoningEffort] = useState(player?.reasoningEffort ?? '');
  const [enabled, setEnabled] = useState(player?.mcpEnabled ?? true);
  const removing = action.kind === 'remove';
  const modelValue = model.trim() || null;
  const effortValue = reasoningEffort.trim().toLowerCase() || null;
  const modelInvalid = !!modelValue && !/^[A-Za-z0-9][A-Za-z0-9.:/_+-]{0,95}$/.test(modelValue);
  const effortInvalid = !!effortValue && !/^[a-z][a-z0-9_-]{0,23}$/.test(effortValue);
  const mutation = useMutation({
    mutationFn: async () => {
      if (action.kind === 'remove') return removeMcpPlayer(action.player.playerId);
      const fields: Partial<PlayerSettings> = {};
      if (name.trim() !== player?.displayName) fields.displayName = name.trim();
      const country = flag.trim().toUpperCase() || null;
      if (country !== player?.flag) fields.flag = country;
      const providerValue = provider || null;
      if (providerValue !== (player?.provider ?? null)) fields.provider = providerValue;
      if (modelValue !== (player?.model ?? null)) fields.model = modelValue;
      if (effortValue !== (player?.reasoningEffort ?? null)) fields.reasoningEffort = effortValue;
      if (enabled !== player?.mcpEnabled) fields.mcpEnabled = enabled;
      return saveMcpPlayer(player?.playerId ?? null, fields);
    },
    onSuccess: onSaved,
    onError: error => { if (error instanceof PlayerRequestError && [404, 409].includes(error.status)) onRefresh(); },
  });
  const status = mutation.error instanceof PlayerRequestError ? mutation.error.status : null;
  const valid = !!name.trim() && [...name.trim()].length <= 40 && !/[\p{Cc}\p{Cf}]/u.test(name) && (!flag || /^[A-Za-z]{2}$/.test(flag))
    && !modelInvalid && !effortInvalid;
  const title = action.kind === 'create' ? t('settings.mcp.add') : t(removing ? 'settings.mcp.confirm' : 'settings.mcp.edit', { name: action.player.displayName });
  return <Dialog open onOpenChange={next => { if (!next) onClose(); }} title={title} returnFocusRef={returnFocusRef} width="sm" dismissible={!mutation.isPending}>
    <form className={styles.accountSection} onSubmit={event => { event.preventDefault(); if ((removing || valid) && !mutation.isPending) mutation.mutate(); }}>
      {removing ? <p>{t('settings.mcp.removeDetail')}</p> : <>
        <Field label={t('settings.mcp.name')} value={name} required onChange={event => setName(event.target.value)} disabled={mutation.isPending} />
        <Field label={t('settings.mcp.flag')} placeholder="CL" value={flag} pattern="[A-Za-z]{2}" maxLength={2} onChange={event => setFlag(event.target.value)} disabled={mutation.isPending} />
        <label className={fieldStyles.field}>
          <span className={fieldStyles.label}>{t('settings.mcp.provider')}</span>
          <select className={fieldStyles.input} value={provider} onChange={event => setProvider(event.target.value as AgentProvider | '')} disabled={mutation.isPending}>
            <option value="">{t('settings.mcp.unspecified')}</option>
            {Object.entries(providerNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <Field label={t('settings.mcp.model')} value={model} maxLength={96} onChange={event => setModel(event.target.value)} disabled={mutation.isPending}
          error={modelInvalid ? t('settings.mcp.modelInvalid') : null} />
        <Field label={t('settings.mcp.reasoningEffort')} value={reasoningEffort} maxLength={24} onChange={event => setReasoningEffort(event.target.value)} disabled={mutation.isPending}
          error={effortInvalid ? t('settings.mcp.reasoningEffortInvalid') : null} />
        <Switch label={t('settings.mcp.enabled')} checked={enabled} onCheckedChange={setEnabled} disabled={mutation.isPending || !!(player && busy(player))} />
      </>}
      {mutation.isError && <p role="alert">{t(status === 409 ? 'settings.mcp.busyError' : status === 404 ? 'settings.mcp.goneError' : 'settings.mcp.saveError')}</p>}
      <div className={styles.accountActions}>
        <Button variant="quiet" disabled={mutation.isPending} onClick={onClose}>{t('home.cancel')}</Button>
        <Button type="submit" variant={removing ? 'danger' : 'decision'} busy={mutation.isPending} disabled={status === 404 || (!removing && !valid)}>{t(removing ? 'settings.mcp.delete' : player ? 'settings.mcp.save' : 'settings.mcp.create')}</Button>
      </div>
    </form>
  </Dialog>;
}
