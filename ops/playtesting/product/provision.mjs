import { createProduct } from './product.mjs'

const [command, name, engineName, scopes] = process.argv.slice(2)
if (!['human', 'agent', 'revoke-agent', 'history'].includes(command)
  || command === 'history' && (!name || !['unlimited', 'default'].includes(engineName))) {
  console.error('Human: provision.mjs human USERNAME < password-file')
  console.error('Agent: provision.mjs agent OWNER AGENT_NAME play,library,history,chat < random-token-file')
  console.error('Revoke agent: provision.mjs revoke-agent < token-file')
  console.error('Match history: provision.mjs history USERNAME unlimited|default')
  process.exit(2)
}
const input = command === 'history' ? null : await new Promise((resolve, reject) => {
  let contents = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', value => {
    contents += value
    if (contents.length > 1024) reject(new Error('Input too long'))
  })
  process.stdin.on('end', () => resolve(contents.replace(/\r?\n$/, '')))
  process.stdin.on('error', reject)
})
let product
try {
  product = await createProduct({ databaseUrl: process.env.DATABASE_URL })
  if (command === 'human') await product.provisionHuman(name, input)
  else if (command === 'agent') await product.provisionAgent(name, engineName, scopes?.split(','), input)
  else if (command === 'history') await product.setUnlimitedMatchHistory([name], engineName === 'unlimited')
  else await product.revokeAgent(input)
  console.log('Playmat provision command completed')
} catch {
  console.error('Playmat provision command failed')
  process.exitCode = 1
} finally {
  await product?.close()
}
