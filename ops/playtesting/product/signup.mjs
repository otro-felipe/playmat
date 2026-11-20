import { isIP } from 'node:net'
import { ProductError } from './decks.mjs'
import { digest, newToken } from './identity.mjs'

const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const emailPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/
const linkLifetimeMinutes = 30
const resendMinutes = 2
const windowMs = 10 * 60_000

function createLimits() {
  const windows = new Map()
  let resetAt = 0
  return (key, maximum) => {
    const now = Date.now()
    if (now >= resetAt) {
      windows.clear()
      resetAt = now + windowMs
    }
    const count = (windows.get(key) ?? 0) + 1
    if (count > maximum || (count === 1 && windows.size >= 1024)) throw new ProductError(429, 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.')
    windows.set(key, count)
  }
}

export function createSignup(pool, identity, publicUrl, mailer) {
  const setupPage = publicUrl && new URL('/register/complete', publicUrl)
  const limit = createLimits()
  const unavailable = 'El registro no está disponible por ahora. Inténtalo de nuevo en unos minutos.'

  function source(req) {
    const proxied = req.headers['x-playmat-client-ip']
    return typeof proxied === 'string' && isIP(proxied) ? proxied : req.socket.remoteAddress
  }

  async function request(req, input) {
    if (!setupPage || !mailer) throw new ProductError(503, unavailable)
    const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : ''
    const localPart = email.split('@', 1)[0]
    if (email.length > 254 || !emailPattern.test(email) || localPart.startsWith('.') || localPart.endsWith('.') || localPart.includes('..')) {
      throw new ProductError(400, 'Ingresa un correo válido.')
    }
    limit('request:' + source(req), 20)
    limit('requests', 120)
    const token = newToken()
    const tokenDigest = digest(token)
    await pool.query('DELETE FROM signup_links WHERE expires_at<=now()')
    const { rowCount } = await pool.query(`INSERT INTO signup_links(email, token_digest, expires_at)
      SELECT $1, $2, now() + make_interval(mins => $3)
      WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE email=$1)
      ON CONFLICT (email) DO UPDATE SET token_digest=EXCLUDED.token_digest,
        expires_at=EXCLUDED.expires_at, issued_at=now()
      WHERE signup_links.issued_at<=now() - make_interval(mins => $4)`,
    [email, tokenDigest, linkLifetimeMinutes, resendMinutes])
    if (!rowCount) return
    const url = new URL(setupPage)
    url.hash = new URLSearchParams({ token }).toString()
    try {
      await mailer.send({ to: email, url: url.toString(), lifetimeMinutes: linkLifetimeMinutes })
    } catch {
      await pool.query('DELETE FROM signup_links WHERE token_digest=$1', [tokenDigest])
      throw new ProductError(503, 'No pudimos enviar el correo. Inténtalo de nuevo.')
    }
  }

  async function complete(req, input) {
    limit('complete:' + source(req), 30)
    limit('completions', 180)
    const { token, username, password } = input ?? {}
    if (typeof token !== 'string' || !tokenPattern.test(token)) throw new ProductError(400, 'El enlace de registro no es válido.')
    return identity.completeSignup(digest(token), username, password)
  }

  return { request, complete }
}

export function postmarkSignupMailer({ token, from }) {
  if (!token || !from) return undefined
  return {
    async send({ to, url, lifetimeMinutes }) {
      const response = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Postmark-Server-Token': token },
        body: JSON.stringify({
          From: from,
          To: to,
          Subject: 'Crea tu cuenta en Thoughtseize',
          TextBody: `Tu cuenta en Thoughtseize está a un paso. Abre este enlace para elegir tu usuario y contraseña:\n\n${url}\n\nEl enlace vence en ${lifetimeMinutes} minutos. Si no lo pediste, puedes ignorar este correo.`,
          TrackOpens: false,
          TrackLinks: 'None',
          MessageStream: 'outbound',
        }),
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      })
      if (!response.ok || (await response.json()).ErrorCode !== 0) throw new Error('Postmark did not accept the signup email')
    },
  }
}
