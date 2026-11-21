import { Check, Link2 } from 'lucide-react';
import { useState } from 'react';
import { useT } from '../i18n';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';

export function SpectatorLink({ tableId, path }: { tableId?: string; path?: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState('');
  const [error, setError] = useState(false);
  async function copy() {
    setBusy(true);
    setError(false);
    let url: string;
    try {
      let watch = path;
      if (!watch) {
        const response = await fetch('/api/playtesting/tables/' + encodeURIComponent(tableId!) + '/spectator-link', { method: 'POST' });
        if (!response.ok) throw new Error();
        watch = (await response.json()).path;
      }
      if (typeof watch !== 'string' || !/^\/watch\/[a-zA-Z0-9_-]+$/.test(watch)) throw new Error();
      url = new URL(watch, window.location.origin).href;
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
    <Button type="button" size="sm" variant="print" icon={copied ? <Check size={15} /> : <Link2 size={15} />}
      busy={busy} onClick={() => void copy()} title={t('watch.linkDetail')}>{t(copied ? 'watch.copied' : 'watch.copy')}</Button>
    {error && <span role="alert">{t('watch.shareFailed')}</span>}
    <Dialog open={!!fallback} onOpenChange={(open) => !open && setFallback('')} title={t('watch.copy')} width="sm">
      <p>{t('watch.linkDetail')}</p><input aria-label={t('watch.copy')} value={fallback} readOnly autoFocus onFocus={event => event.currentTarget.select()} />
    </Dialog>
  </>;
}
