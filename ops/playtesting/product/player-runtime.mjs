import { ProductError } from './decks.mjs'

const providers = new Set(['openai', 'claude', 'gemini'])
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9.:/_+-]{0,95}$/
const effortPattern = /^[a-z][a-z0-9_-]{0,23}$/

export function runtimeFields(input, allowNull = false) {
  const { provider, model, reasoningEffort } = input ?? {}
  const valid = (value, check) => value === undefined || (allowNull && value === null) || check(value)
  if (!valid(provider, value => providers.has(value))
    || !valid(model, value => typeof value === 'string' && modelPattern.test(value))
    || !valid(reasoningEffort, value => typeof value === 'string' && effortPattern.test(value))) {
    throw new ProductError(400, 'Invalid agent provider, model or reasoning effort')
  }
  return { provider: provider ?? null, model: model ?? null, reasoningEffort: reasoningEffort ?? null }
}

export function declaredRuntime({ provider, model, reasoningEffort }) {
  return {
    ...(provider && { provider }),
    ...(model && { model }),
    ...(reasoningEffort && { reasoningEffort }),
  }
}

export async function readPlayerRuntime(db, actor) {
  if (!actor.agent || !actor.playerId) return {}
  const { rows: [profile] } = await db.query(
    'SELECT provider,model,reasoning_effort AS "reasoningEffort" FROM player_profiles WHERE id=$1 AND account_id=$2',
    [actor.playerId, actor.accountId],
  )
  return profile ?? {}
}
