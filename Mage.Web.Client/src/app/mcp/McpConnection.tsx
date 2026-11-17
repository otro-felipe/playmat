import { useState } from 'react';
import { registerMessages, useT } from '../i18n';
import messages from '../i18n/en/social';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { mcpConnectionGuideHidden, mcpEndpoint, saveMcpConnectionGuidePreference } from './connectionGuide';
import styles from './McpConnection.module.css';

registerMessages(messages);

export function McpConnectionEndpoint({ endpoint }: { endpoint: string }) {
  const t = useT();
  return (
    <div className={styles.endpoint}>
      <p>{t('mcpInvite.connect')}</p>
      <code>{endpoint}</code>
    </div>
  );
}

export function McpConnectionDialog({ onClose }: { onClose(): void }) {
  const t = useT();
  const [hideAgain, setHideAgain] = useState(mcpConnectionGuideHidden);
  const endpoint = mcpEndpoint();
  const command = `codex mcp add playmat --url ${endpoint} --bearer-token-env-var PLAYMAT_MCP_TOKEN`;

  function close() {
    saveMcpConnectionGuidePreference(hideAgain);
    onClose();
  }

  return (
    <Dialog
      open
      title={t('mcpConnection.title')}
      onOpenChange={(open) => !open && close()}
      footer={<Button variant="decision" onClick={close}>{t('home.continue')}</Button>}
    >
      <McpConnectionEndpoint endpoint={endpoint} />
      <ol className={styles.steps}>
        <li>{t('mcpConnection.credential')}</li>
        <li>
          {t('mcpConnection.codex')}
          <code className={styles.command}>{command}</code>
        </li>
        <li>{t('mcpConnection.share', { copyLink: t('mcpInvite.copyLink') })}</li>
      </ol>
      <p className={styles.browser}>{t('mcpConnection.browser')}</p>
      <label className={styles.check}>
        <input type="checkbox" checked={hideAgain} onChange={(event) => setHideAgain(event.target.checked)} />
        {t('mcpConnection.hideAgain')}
      </label>
    </Dialog>
  );
}
