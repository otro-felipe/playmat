import { registerMessages, useT } from '../i18n';
import messages from '../i18n/en/events';
import { useTournamentOwner, type Profile } from '../tournaments/tournamentApi';
import { Button } from '../ui/Button';
import styles from './ProfileDialog.module.css';

registerMessages(messages);

export function RegisteredAgents({ agents }: { agents: Profile['agents'] }) {
  const t = useT();
  return agents.length ? (
    <ul className={styles.agentList}>
      {agents.map((agent) => <li key={agent.id}>{agent.name}</li>)}
    </ul>
  ) : <p>{t('cup.noAgents')}</p>;
}

export function OwnerAgents({ owner }: { owner: string }) {
  const t = useT();
  const profile = useTournamentOwner(owner);
  return (
    <section className={styles.progress} aria-label={t('cup.agents')}>
      <h3 className={styles.recentTitle}>{t('cup.agents')}</h3>
      {profile.data ? <RegisteredAgents agents={profile.data.agents} /> : profile.isError ? (
        <div>
          <p role="alert">{t('cup.agentLoadError')}</p>
          <Button size="sm" variant="quiet" onClick={() => void profile.refetch()}>{t('cup.retry')}</Button>
        </div>
      ) : <p role="status">{t('cup.loadingAgents')}</p>}
    </section>
  );
}
