import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Minimal .env loader (KEY=VALUE per line, # comments, optional quotes).
 * Looks at BILIBILI_ENV_FILE, ./.env, <project root>/.env, then ~/.bilibili-agent-mcp/.env.
 * Never overrides variables that are already set in the real environment.
 */
export const parseEnvFile = (text: string) => {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!m) continue
    let value = m[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    } else {
      value = value.replace(/\s+#.*$/, '')
    }
    out[m[1]] = value
  }
  return out
}

export const loadEnvFiles = (env: NodeJS.ProcessEnv = process.env) => {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const candidates = [
    env.BILIBILI_ENV_FILE,
    resolve('.env'),
    join(projectRoot, '.env'),
    join(homedir(), '.bilibili-agent-mcp', '.env'),
  ].filter((p, i, all): p is string => Boolean(p) && all.indexOf(p) === i)
  const loaded: string[] = []
  for (const file of candidates) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const [key, value] of Object.entries(parseEnvFile(text))) {
      if (env[key] === undefined || env[key] === '') env[key] = value
    }
    loaded.push(file)
  }
  return loaded
}
