import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId } from 'react';
import { useT } from '../i18n';
import { Switch } from '../ui/Switch';
import { OwnedSpectatorLink } from './SpectatorLink';
import styles from './SpectatorBoard.module.css';

import { ownedBroadcastsKey, saveVisibility, VisibilityLocked, type OwnedBroadcast, type Visibility } from './spectatorVisibility';

export function OwnedSpectatorControls({ table, owner }: { table: OwnedBroadcast; owner: string | null }) {
  const t = useT();
  const detailId = useId();
  const client = useQueryClient();
  const queryKey = ownedBroadcastsKey(owner);
  const save = useMutation({
    mutationFn: (value: Visibility) => saveVisibility(table.tableId, value),
    onMutate: () => client.cancelQueries({ queryKey }),
    onSuccess: value => client.setQueryData<OwnedBroadcast[]>(queryKey, rows => rows?.map(row =>
      row.tableId === table.tableId ? { ...row, spectatorVisibility: value } : row)),
    onSettled: () => { void client.invalidateQueries({ queryKey }); },
    retry: false,
  });
  const allowed = table.spectatorVisibility === 'both-hands';
  const locked = save.error instanceof VisibilityLocked;
  const mayChange = table.canConfigureSpectatorVisibility === true && !locked;
  return <div className={styles.ownerControls}>
    {mayChange && <div className={styles.permission}>
      <Switch checked={save.isPending ? save.variables === 'both-hands' : allowed}
        disabled={save.isPending} describedBy={detailId} label={t('watch.configureHands')}
        onCheckedChange={checked => save.mutate(checked ? 'both-hands' : 'public-board')} />
      <p id={detailId}>{t('watch.configureHandsHint')}</p>
    </div>}
    {save.isError && <p role="alert">{t(locked ? 'watch.visibilityLocked' : 'watch.visibilityFailed')}</p>}
    <OwnedSpectatorLink key={String(allowed)} tableId={table.tableId} canShareHands={allowed && !save.isPending} />
  </div>;
}
