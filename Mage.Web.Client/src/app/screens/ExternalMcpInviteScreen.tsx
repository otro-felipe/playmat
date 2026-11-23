import { useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { registerMessages, useT } from '../i18n';
import messages from '../i18n/en/social';
import { Button } from '../ui/Button';
import { Zone } from '../ui/Zone';
import styles from './JoinScreen.module.css';

registerMessages(messages);

export function ExternalMcpInviteScreen() {
  const t = useT();
  const { tableId = '' } = useParams();
  const { hash, pathname, key } = useLocation();
  const [feedback, setFeedback] = useState<{ location: string; copied: boolean }>();
  const valid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(tableId)
    && /^#invite=[A-Za-z0-9_-]{43}$/.test(hash);

  async function copyInstructions() {
    const link = window.location.origin + pathname + hash;
    try {
      await navigator.clipboard.writeText(t('externalMcpInvite.instructions', { link }));
      setFeedback({ location: key, copied: true });
    } catch {
      setFeedback({ location: key, copied: false });
    }
  }

  return <main className={styles.page}>
    <Zone label={t('externalMcpInvite.title')} className={styles.card}>
      <p className={styles.note}>{t(valid ? 'externalMcpInvite.handoff' : 'externalMcpInvite.incomplete')}</p>
      {valid && <Button variant="decision" onClick={() => void copyInstructions()}>{t('mcpInvite.copy')}</Button>}
      {valid && feedback?.location === key &&
        <p className={styles.note} role="status">{t(feedback.copied ? 'mcpInvite.copied' : 'externalMcpInvite.clipboard')}</p>}
    </Zone>
  </main>;
}
