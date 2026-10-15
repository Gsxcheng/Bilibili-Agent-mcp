// Remote HTTP mode: real MCP client over Streamable HTTP, token protection, file links, .env parsing.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startHttpServer, resolveToken } from '../dist/http-server.js'
import { parseEnvFile } from '../dist/env-file.js'
import { loadConfig } from '../dist/config.js'
import { BiliClient } from '../dist/http.js'
import { createMock, BVID } from './mock-bilibili.mjs'

const TOKEN = 'test-token-0123456789abcdef'
const dir = mkdtempSync(join(tmpdir(), 'bili-http-'))
let server, base, mock

before(async () => {
  mock = createMock()
  const client = new BiliClient(loadConfig({ BILIBILI_DOWNLOAD_DIR: dir }), mock.fetchImpl)
  server = await startHttpServer(client, { host: '127.0.0.1', port: 0, token: TOKEN, log: () => {} })
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => {
  server?.close()
  rmSync(dir, { recursive: true, force: true })
})

const connect = async (url, init) => {
  const client = new Client({ name: 'http-test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), init ? { requestInit: init } : undefined))
  return client
}
const initBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '1' } },
})
const post = (path, headers = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: initBody,
  })

test('secret-path URL: full MCP session over HTTP', async () => {
  const client = await connect(`${base}/mcp/${TOKEN}`)
  assert.equal(client.getServerVersion().name, 'bilibili-agent-mcp')
  const { tools } = await client.listTools()
  assert.equal(tools.length, 15)
  const res = await client.callTool({ name: 'bili_video_info', arguments: { input: BVID } })
  assert.equal(res.isError, undefined)
  assert.equal(JSON.parse(res.content[0].text).title, '测试视频')
  await client.close()
})

test('Bearer header on /mcp also works', async () => {
  const client = await connect(`${base}/mcp`, { headers: { Authorization: `Bearer ${TOKEN}` } })
  const r = await client.callTool({ name: 'bili_resolve', arguments: { input: 'av170001' } })
  assert.match(r.content[0].text, /BV17x411w7KC/)
  await client.close()
})

test('responses are plain JSON, not SSE (works behind Cloudflare quick tunnels)', async () => {
  const res = await post(`/mcp/${TOKEN}`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /application\/json/)
  const body = await res.json()
  assert.equal(body.result.serverInfo.name, 'bilibili-agent-mcp')
})

test('wrong / missing token is indistinguishable from an unknown path', async () => {
  for (const [path, headers] of [
    ['/mcp/wrong-token-0123456789abcdef', {}],
    ['/mcp', {}],
    ['/mcp', { Authorization: 'Bearer nope' }],
    [`/mcp/${TOKEN}x`, {}],
    ['/.well-known/oauth-protected-resource', {}],
  ]) {
    const res = await post(path, headers)
    assert.equal(res.status, 404, path)
    assert.equal(await res.text(), 'not found')
  }
  const health = await fetch(`${base}/health`)
  assert.equal(await health.text(), 'ok')
})

test('GET/DELETE on the MCP endpoint → 405 (stateless)', async () => {
  const get = await fetch(`${base}/mcp/${TOKEN}`, { headers: { Accept: 'text/event-stream' } })
  assert.equal(get.status, 405)
  const del = await fetch(`${base}/mcp/${TOKEN}`, { method: 'DELETE' })
  assert.equal(del.status, 405)
  const bad = await fetch(`${base}/mcp/${TOKEN}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' })
  assert.equal(bad.status, 400)
})

test('saved files get token-protected download links derived from the public host', async () => {
  const client = await connect(`${base}/mcp/${TOKEN}`, {
    headers: { 'X-Forwarded-Host': 'bili.example.com', 'X-Forwarded-Proto': 'https' },
  })
  const r = await client.callTool({ name: 'bili_subtitles', arguments: { input: BVID, format: 'srt', save: true } })
  const data = JSON.parse(r.content[0].text)
  assert.match(data.downloadUrl, new RegExp(`^https://bili\\.example\\.com/files/${TOKEN}/`))
  // fetch it back through the local server
  const localUrl = data.downloadUrl.replace('https://bili.example.com', base)
  const file = await fetch(localUrl)
  assert.equal(file.status, 200)
  assert.match(file.headers.get('content-disposition'), /attachment; filename\*=UTF-8''/)
  assert.match(await file.text(), /大家好/)

  const dl = await client.callTool({ name: 'bili_download', arguments: { input: BVID, mode: 'none', extras: ['metadata'], wait_seconds: 20 } })
  const job = JSON.parse(dl.content[0].text).jobs[0]
  assert.equal(job.status, 'done')
  assert.match(job.downloads[0].url, /\/files\/test-token-0123456789abcdef\/.+ffmetadata\.txt$/)
  await client.close()
})

test('file endpoint rejects wrong token and path traversal', async () => {
  writeFileSync(join(dir, 'ok.txt'), 'hello')
  assert.equal((await fetch(`${base}/files/${TOKEN}/ok.txt`)).status, 200)
  assert.equal((await fetch(`${base}/files/wrong-token-0123456789abcdef/ok.txt`)).status, 404)
  for (const p of ['..%2F..%2Fetc%2Fpasswd', '%2E%2E/%2E%2E/etc/passwd', '..%5C..%5Cwindows', 'nope.txt', '%E0%A4%A']) {
    const res = await fetch(`${base}/files/${TOKEN}/${p}`)
    assert.ok([400, 404].includes(res.status), `${p} → ${res.status}`)
  }
})

test('token: env validation, generated + persisted when absent', async () => {
  await assert.rejects(resolveToken({ BILIBILI_MCP_TOKEN: 'short' }), /至少 16 位/)
  await assert.rejects(resolveToken({ BILIBILI_MCP_TOKEN: 'has spaces in it 0123456' }), /只能包含/)
  assert.equal((await resolveToken({ BILIBILI_MCP_TOKEN: TOKEN })).token, TOKEN)
  const file = join(dir, 'sub', 'token')
  const a = await resolveToken({ BILIBILI_MCP_TOKEN_FILE: file })
  const b = await resolveToken({ BILIBILI_MCP_TOKEN_FILE: file })
  assert.equal(a.token, b.token, 'persisted across restarts')
  assert.ok(a.token.length >= 32)
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('.env parsing', () => {
  const env = parseEnvFile(`
# comment
BILIBILI_COOKIE="SESSDATA=a; bili_jct=b"
export BILIBILI_MCP_PORT=9000   # inline comment
EMPTY=
QUOTED='x y'
bad line
`)
  assert.deepEqual(env, { BILIBILI_COOKIE: 'SESSDATA=a; bili_jct=b', BILIBILI_MCP_PORT: '9000', EMPTY: '', QUOTED: 'x y' })
})

test('CLI: --http starts, prints connector URL, serves requests', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bili-home-'))
  const proc = spawn(process.execPath, ['dist/index.js', '--http', '--port', '0'], {
    env: { ...process.env, HOME: home, USERPROFILE: home, BILIBILI_MCP_TOKEN: TOKEN, BILIBILI_DOWNLOAD_DIR: dir },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let err = ''
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${err}`)), 10000)
    proc.stderr.on('data', d => {
      err += d
      if (err.includes('访问密钥来源')) {
        clearTimeout(t)
        resolve()
      }
    })
  })
  proc.kill()
  assert.match(err, /HTTP 模式已启动/)
  assert.match(err, new RegExp(`/mcp/${TOKEN}`))
  const help = execFileSync(process.execPath, ['dist/index.js', '--help']).toString()
  assert.match(help, /--http/)
  rmSync(home, { recursive: true, force: true })
})
