import { Check, Eye, Link2 } from 'lucide-react';
import { useId, useState } from 'react';
import { useT } from '../i18n';
import { Button } from '../ui/Button';
import { Switch } from '../ui/Switch';
import { Dialog } from '../ui/Dialog';

export function SpectatorLink({ tableId, path, publicBoard, openable, bothHands }: {
  tableId?: string; path?: string; publicBoard?: boolean; openable?: boolean; bothHands?: boolean;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState('');
  const [error, setError] = useState(false);
  const detail = t(bothHands ? 'watch.bothDetail' : publicBoard ? 'watch.publicDetail' : 'watch.linkDetail');
  async function shareLink(action: 'copy' | 'open') {
    setBusy(true);
    setError(false);
    let url: string;
    try {
      let watch = path;
      if (!watch) {
        const response = await fetch('/api/playtesting/tables/' + encodeURIComponent(tableId!) + '/spectator-link' + (bothHands ? '?visibility=both-hands' : ''), { method: publicBoard || bothHands ? 'GET' : 'POST' });
        if (!response.ok) throw new Error();
        watch = (await response.json()).path;
      }
      if (typeof watch !== 'string' || !/^\/watch\/[a-zA-Z0-9_-]+$/.test(watch)) throw new Error();
      url = new URL(watch, window.location.origin).href;
      if (action === 'open') {
        window.location.assign(url);
        return;
      }
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
      } catch {
        setFallback(url);
      }
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return <>
    {openable && <Button type="button" size="sm" variant="quiet" icon={<Eye size={15} />} disabled={busy}
      onClick={() => void shareLink('open')}>{t('watch.open')}</Button>}
    <Button type="button" size="sm" variant="print" icon={copied ? <Check size={15} /> : <Link2 size={15} />}
      busy={busy} onClick={() => void shareLink('copy')} title={detail}>{t(copied ? 'watch.copied' : 'watch.copy')}</Button>
    {error && <span role="alert">{t('watch.shareFailed')}</span>}
    <Dialog open={!!fallback} onOpenChange={(open) => !open && setFallback('')} title={t('watch.copy')} width="sm">
      <p>{detail}</p><input aria-label={t('watch.copy')} value={fallback} readOnly autoFocus onFocus={event => event.currentTarget.select()} />
    </Dialog>
  </>;
}


export function OwnedSpectatorLink({ tableId, canShareHands }: { tableId: string; canShareHands: boolean }) {
  const t = useT();
  const [selected, setSelected] = useState(false);
  const bothHands = canShareHands && selected;
  const id = useId();
  return <div>
    {canShareHands && <Switch checked={bothHands} onCheckedChange={setSelected} controls={id} label={t('watch.shareBoth')} />}
    <div id={id}>
      {bothHands && <p>{t('watch.bothDetail')}</p>}
      <SpectatorLink key={String(bothHands)} tableId={tableId} publicBoard={!bothHands} bothHands={bothHands} openable />
    </div>
  </div>;
}
