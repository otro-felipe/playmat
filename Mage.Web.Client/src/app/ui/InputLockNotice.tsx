import type { BrowserInputLock } from '../../core/game/gameSession';
import { useT } from '../i18n';
import { Button } from './Button';

export function InputLockNotice({ lock, onLeave, leaveLabel, onResync }: {
  lock: NonNullable<BrowserInputLock>;
  onLeave(): void;
  leaveLabel?: string;
  onResync?(): void;
}) {
  const t = useT();
  return <>
    <span role="status">{t(`match.input.${lock}`)}</span>
    {onResync && <Button variant="quiet" onClick={onResync}>{t('match.input.resync')}</Button>}
    <Button variant="quiet" onClick={onLeave}>{leaveLabel === 'Back to Play' || !leaveLabel ? t('match.input.back') : leaveLabel}</Button>
  </>;
}
