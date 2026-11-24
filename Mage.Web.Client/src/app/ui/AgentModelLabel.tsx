import { providerNames, type AgentModel } from './agentModel';
import claude from './provider-logos/claude.svg?no-inline';
import gemini from './provider-logos/gemini.svg?no-inline';
import openai from './provider-logos/openai.svg?no-inline';
import styles from './AgentModelLabel.module.css';

const logos = { openai, claude, gemini };

export function AgentModelLabel({ provider, model }: AgentModel) {
  const known = provider && Object.hasOwn(logos, provider) ? provider : null;
  if (!known && !model) return null;
  return <span className={styles.label}>
    {known && <img alt={providerNames[known]} src={logos[known]} className={known === 'openai' ? styles.openai : undefined} />}
    {model && <span title={model}>{model}</span>}
  </span>;
}
