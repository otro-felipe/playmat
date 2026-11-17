import { prepareProvisionBundle } from './identity.mjs'

// Operators pipe this output into the provider's write-only secret assignment.
try {
  let input = ''
  for await (const chunk of process.stdin) {
    input += chunk.toString('utf8')
    if (Buffer.byteLength(input) > 16384) throw new Error('Input too large')
  }
  const bundle = await prepareProvisionBundle(JSON.parse(input))
  process.stdout.write(JSON.stringify(bundle))
} catch {
  console.error('Could not prepare a valid Playmat provisioning bundle')
  process.exitCode = 1
}
