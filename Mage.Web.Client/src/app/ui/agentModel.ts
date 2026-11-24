export const providerNames = {
  openai: 'OpenAI',
  claude: 'Claude',
  gemini: 'Gemini',
} as const;

export type AgentProvider = keyof typeof providerNames;

export interface AgentModel {
  provider?: AgentProvider | null;
  model?: string | null;
  reasoningEffort?: string | null;
}
