import { createHash } from 'node:crypto'
import { ProductError } from './decks.mjs'

export const signupChallengeAction = 'turnstile-spin-v2'
export const loginChallengeAction = 'password-login'
const challengeOrigin = 'https://challenges.cloudflare.com'
const verificationUrl = challengeOrigin + '/turnstile/v0/siteverify'
const tokenLifetime = 300_000
const invalid = 'Completa la verificación e inténtalo de nuevo.'
const unavailable = 'La verificación está temporalmente fuera de servicio. Inténtalo de nuevo.'

export function createTurnstile(publicUrl, {
  siteKey, secret, fetch: verifyRequest = globalThis.fetch,
} = {}) {
  if (!siteKey && !secret) return null
  if (!siteKey || !secret || !publicUrl) throw Error('Turnstile requires both keys and a public URL')
  const hostname = new URL(publicUrl).hostname
  const verifiedTokens = new Map()
  let pruneAt = 0

  async function verify(token, action) {
    if (typeof token !== 'string' || !token.length || token.length > 2048) throw new ProductError(403, invalid)
    const now = Date.now()
    if (now >= pruneAt) {
      for (const [key, expiresAt] of verifiedTokens) {
        if (expiresAt <= now) verifiedTokens.delete(key)
      }
      pruneAt = now + 60_000
    }
    const key = createHash('sha256').update(token).digest('hex')
    if (verifiedTokens.has(key)) throw new ProductError(403, invalid)
    if (verifiedTokens.size >= 4096) throw new ProductError(503, unavailable)
    // Reserve before the network call. Cloudflare redemption is eventually consistent.
    verifiedTokens.set(key, now + tokenLifetime)
    let accepted = false
    try {
      const response = await verifyRequest(verificationUrl, {
        method: 'POST',
        body: new URLSearchParams({ secret, response: token }),
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) throw Error('Turnstile unavailable')
      const result = await response.json()
      accepted = result?.success === true && result.hostname === hostname && result.action === action
    } catch {
      throw new ProductError(503, unavailable)
    } finally {
      if (!accepted) verifiedTokens.delete(key)
    }
    if (!accepted) throw new ProductError(403, invalid)
  }

  return { siteKey, verify }
}
