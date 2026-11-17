import { createHmac, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { ProductError } from './decks.mjs'

const timeoutMs = 6_000
const responseLimit = 4_096
const localNames = /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/i
const deniedIpv4 = new BlockList()
for (const [network, length] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4], ['168.63.129.16', 32],
]) deniedIpv4.addSubnet(network, length)
const globalIpv6 = new BlockList()
globalIpv6.addSubnet('2000::', 3, 'ipv6')
const deniedIpv6 = new BlockList()
for (const [network, length] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3ffe::', 16], ['3fff::', 20],
]) deniedIpv6.addSubnet(network, length, 'ipv6')

export function callbackError(reason) {
  const error = new ProductError(422, 'The webhook destination could not be verified.')
  error.rpcCode = -32015
  error.reason = reason
  return error
}

function publicAddress({ address, family }) {
  if (isIP(address) !== family) return false
  if (family === 4) return !deniedIpv4.check(address)
  return globalIpv6.check(address, 'ipv6') && !deniedIpv6.check(address, 'ipv6')
}

export function webhookUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || !URL.canParse(value)) throw callbackError('invalid_url')
  const url = new URL(value)
  const hostname = url.hostname.replace(/\.$/, '')
  if (url.protocol !== 'https:' || !hostname.includes('.') || url.username || url.password || url.hash ||
      url.port === '0' || localNames.test(hostname) || isIP(hostname) || hostname.startsWith('[')) {
    throw callbackError('invalid_url')
  }
  return url
}

export async function resolveWebhookTarget(value, resolver = lookup) {
  const url = webhookUrl(value)
  let addresses
  try {
    addresses = await resolver(url.hostname, { all: true })
  } catch {
    throw callbackError('dns_failed')
  }
  if (!addresses.length || addresses.some(address => !publicAddress(address))) throw callbackError('invalid_url')
  const { address, family } = addresses.find(item => item.family === 4) ?? addresses[0]
  return { url, address, family }
}

export function decodeSecret(value) {
  const encoded = typeof value === 'string' && /^whsec_([A-Za-z0-9+/_-]{32,88}={0,2})$/.exec(value)?.[1]
  if (!encoded) throw new ProductError(400, 'Provide a valid webhook signing secret.')
  const key = Buffer.from(encoded, 'base64')
  const canonical = key.toString('base64')
  const normalized = encoded.replaceAll('-', '+').replaceAll('_', '/')
  if (key.length < 24 || key.length > 64 || (normalized !== canonical && normalized !== canonical.replace(/=+$/, ''))) {
    throw new ProductError(400, 'Provide a valid webhook signing secret.')
  }
  return key
}

export function signedWebhookRequest(subscriptionId, id, value, key, at = new Date(), previousKey) {
  const body = Buffer.from(JSON.stringify(value))
  const timestamp = String(Math.floor(at.getTime() / 1000))
  const signature = signingKey => 'v1,' + createHmac('sha256', signingKey)
    .update(id + '.' + timestamp + '.').update(body).digest('base64')
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'content-length': String(body.length),
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': previousKey ? signature(key) + ' ' + signature(previousKey) : signature(key),
      'x-mcp-subscription-id': subscriptionId,
    },
  }
}

export function matchesChallenge(body, expected) {
  try {
    const { challenge } = JSON.parse(body)
    if (typeof challenge !== 'string') return false
    const proposed = Buffer.from(challenge)
    const original = Buffer.from(expected)
    return proposed.length === original.length && timingSafeEqual(proposed, original)
  } catch {
    return false
  }
}

export async function postWebhook(value, { headers, body }) {
  const signal = AbortSignal.timeout(timeoutMs)
  const target = await Promise.race([
    resolveWebhookTarget(value),
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(callbackError('timeout')), { once: true })),
  ])
  return new Promise((resolve, reject) => {
    const req = request(target.url, {
      method: 'POST',
      agent: false,
      autoSelectFamily: false,
      family: target.family,
      signal,
      headers,
      // Keep the URL hostname for TLS verification. Connect only to its validated address.
      lookup: (_hostname, opts, done) => opts.all
        ? done(null, [{ address: target.address, family: target.family }])
        : done(null, target.address, target.family),
    }, res => {
      const chunks = []
      let length = 0
      res.on('data', chunk => {
        length += chunk.length
        if (length <= responseLimit) chunks.push(chunk)
        else req.destroy(callbackError('response_too_large'))
      })
      res.once('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
      res.once('error', () => reject(callbackError('delivery_failed')))
    })
    req.once('error', error => reject(error.rpcCode ? error : callbackError(signal.aborted ? 'timeout' : 'delivery_failed')))
    req.end(body)
  })
}
