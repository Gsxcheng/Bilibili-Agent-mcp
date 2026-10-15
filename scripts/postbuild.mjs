import { chmodSync, readFileSync, writeFileSync } from 'node:fs'

const entry = new URL('../dist/index.js', import.meta.url)
const code = readFileSync(entry, 'utf8')
if (!code.startsWith('#!')) {
  writeFileSync(entry, `#!/usr/bin/env node\n${code}`)
}
chmodSync(entry, 0o755)
