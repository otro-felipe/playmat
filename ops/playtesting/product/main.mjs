import { createProduct } from './product.mjs'
import { s3Store } from './archive.mjs'
import { postmarkSignupMailer } from './signup.mjs'

async function start() {
  const bucket = process.env.PLAYMAT_S3_BUCKET
  const store = bucket ? s3Store({
    bucket, endpoint: process.env.PLAYMAT_S3_ENDPOINT, region: process.env.AWS_REGION,
    forcePathStyle: process.env.PLAYMAT_S3_FORCE_PATH_STYLE === 'true',
  }) : {
    async put() { throw new Error('S3 replay archive is not configured') },
    async get() { throw new Error('S3 replay archive is not configured') },
  }
  const product = await createProduct({
    databaseUrl: process.env.DATABASE_URL,
    replayDirectory: process.env.PLAYMAT_REPLAY_DIR ?? '/opt/xmage/saved/replays',
    store,
    purgeExpiredHistory: process.env.PLAYMAT_PURGE_EXPIRED_MATCH_HISTORY === 'true',
    insecureCookie: process.env.PLAYMAT_INSECURE_COOKIE === 'true',
    publicUrl: process.env.PLAYMAT_PUBLIC_URL,
    signup: postmarkSignupMailer({ token: process.env.PLAYMAT_POSTMARK_TOKEN, from: process.env.PLAYMAT_POSTMARK_FROM }),
    turnstile: { siteKey: process.env.PLAYMAT_TURNSTILE_SITE_KEY, secret: process.env.PLAYMAT_TURNSTILE_SECRET },
    oauthClients: JSON.parse(process.env.PLAYMAT_OAUTH_CLIENTS ?? '[]'),
  })
  const provision = process.env.PLAYMAT_PROVISION_ONCE
  if (provision) {
    if (Buffer.byteLength(provision) > 16384) throw new Error('Provisioning input too large')
    await product.importProvisionBundle(JSON.parse(provision))
  }
  if (process.env.PLAYMAT_TOURNAMENT_ADMIN_IDS !== undefined) {
    await product.setTournamentAdmins(process.env.PLAYMAT_TOURNAMENT_ADMIN_IDS.split(',').map(id=>id.trim()).filter(Boolean))
  }
  const unlimitedHistoryUsers = process.env.PLAYMAT_UNLIMITED_HISTORY_USERS?.trim()
  if (unlimitedHistoryUsers) await product.setUnlimitedMatchHistory(unlimitedHistoryUsers.split(','), true)
  await product.archiveGames({ markInterrupted: true })
  const reset = process.env.PLAYMAT_HISTORY_RESET?.trim()
  if (reset) {
    const [username, timestamp, ...extra] = reset.split('@')
    if (extra.length || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(timestamp)) throw Error('Invalid history cutoff')
    const { hidden, remainingClosed } = await product.resetMatchHistory(username, Date.parse(timestamp))
    console.log(`Playmat history reset applied: ${hidden} hidden, ${remainingClosed} newer closed matches`)
  }
  product.server.listen(Number(process.env.PRODUCT_PORT ?? '8790'), '127.0.0.1')
  product.startMcpEvents()
  product.startTournaments()
  const archive = setInterval(() => product.archiveGames().catch(() => console.warn('Playmat archive scan delayed')), 5000)
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      clearInterval(archive)
      void product.stopTournaments().finally(()=>product.server.close(() => void product.close()))
    })
  }
}

try {
  await start()
} catch {
  console.error('Playmat product startup failed')
  process.exit(1)
}
