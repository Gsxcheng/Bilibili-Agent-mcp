/**
 * Remote (Streamable HTTP) mode, for Claude / ChatGPT web connectors.
 *
 *   POST /mcp/<token>          MCP endpoint (secret path — paste this URL into the connector)
 *   POST /mcp + Authorization: Bearer <token>   same, for clients that can send headers
 *   GET  /files/<token>/<name> download a file produced by the tools (inside BILIBILI_DOWNLOAD_DIR only)
 *   GET  /health               liveness probe, reveals nothing
 *
 * Stateless: every request gets a fresh MCP server, the BiliClient (WBI keys, buvid, download jobs) is shared.
 * Responses are plain JSON (no SSE) so it also works behind Cloudflare quick tunnels, which don't support SSE.
 */
import { createReadStream } from 'node:fs'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer, IncomingMessage, Server, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, isAbsolute } from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { BiliClient } from './http.js'
import { buildServer } from './server.js'

export interface HttpOptions {
  host: string
  port: number
  token: string
  /** override the public base URL used in file links (otherwise derived from request headers) */
  publicUrl?: string
  log?: (line: string) => void
}

const MAX_BODY = 4 * 1024 * 1024
const TOKEN_FILE = join(homedir(), '.bilibili-agent-mcp', 'token')

/** Token from env, else a persisted random one (so the connector URL survives restarts). */
export const resolveToken = async (env: NodeJS.ProcessEnv = process.env) => {
  const fromEnv = env.BILIBILI_MCP_TOKEN?.trim()
  if (fromEnv) {
    if (fromEnv.length < 16 || !/^[A-Za-z0-9_-]+$/.test(fromEnv)) {
      throw new Error('BILIBILI_MCP_TOKEN 至少 16 位，且只能包含字母、数字、- 和 _')
    }
    return { token: fromEnv, source: 'env' as const }
  }
  const file = env.BILIBILI_MCP_TOKEN_FILE || TOKEN_FILE
  try {
    const saved = (await readFile(file, 'utf8')).trim()
    if (saved.length >= 16) return { token: saved, source: file }
  } catch {
    /* create below */
  }
  const token = randomBytes(24).toString('base64url')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${token}\n`, { mode: 0o600 })
  await chmod(file, 0o600).catch(() => {})
  return { token, source: file }
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolveBody, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  if (res.headersSent) return
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    ...headers,
  })
  res.end(text)
}

const jsonRpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null })

/** Base URL as the outside world sees it (Cloudflare sets Host + X-Forwarded-Proto). */
const publicBase = (req: IncomingMessage, override?: string) => {
  if (override) return override.replace(/\/+$/, '')
  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || 'localhost'
  const forwarded = (req.headers['x-forwarded-proto'] as string)?.split(',')[0]?.trim()
  const local = /^(localhost|127\.|\[::1\])/.test(host)
  return `${forwarded || (local ? 'http' : 'https')}://${host}`
}

export const startHttpServer = async (client: BiliClient, options: HttpOptions): Promise<Server> => {
  const log = options.log ?? ((line: string) => console.error(line))
  const { token } = options
  const downloadDir = resolve(client.config.downloadDir)

  const handleMcp = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' || req.method === 'DELETE') {
      // stateless server: no standalone SSE stream, no sessions to delete
      return send(res, 405, jsonRpcError(-32000, 'Method not allowed'), { Allow: 'POST' })
    }
    if (req.method !== 'POST') return send(res, 405, jsonRpcError(-32000, 'Method not allowed'), { Allow: 'POST' })
    let parsed: unknown
    try {
      parsed = JSON.parse(await readBody(req))
    } catch {
      return send(res, 400, jsonRpcError(-32700, 'Parse error'))
    }
    const base = publicBase(req, options.publicUrl)
    const server = buildServer(client, {
      fileUrl: path => {
        const rel = relative(downloadDir, resolve(path))
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) return undefined
        return `${base}/files/${token}/${rel.split(/[\\/]/).map(encodeURIComponent).join('/')}`
      },
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, parsed)
    } catch (error) {
      log(`[bilibili-agent-mcp] request failed: ${(error as Error).message}`)
      send(res, 500, jsonRpcError(-32603, 'Internal server error'))
    }
  }

  const handleFile = async (res: ServerResponse, rawPath: string) => {
    let rel: string
    try {
      rel = rawPath.split('/').map(decodeURIComponent).join('/')
    } catch {
      return send(res, 400, 'bad path')
    }
    const full = resolve(downloadDir, rel)
    const inside = relative(downloadDir, full)
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) return send(res, 404, 'not found')
    const info = await stat(full).catch(() => undefined)
    if (!info?.isFile()) return send(res, 404, 'not found')
    const name = basename(full)
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(info.size),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'private, no-store',
    })
    createReadStream(full).pipe(res)
  }

  const server = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname

      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
          'Access-Control-Max-Age': '86400',
        })
        return res.end()
      }
      res.setHeader('Access-Control-Allow-Origin', '*')

      if (path === '/health' || path === '/') return send(res, 200, 'ok')

      const mcpPath = path.match(/^\/mcp\/([^/]+)\/?$/)
      if (mcpPath && safeEqual(mcpPath[1], token)) return await handleMcp(req, res)
      if (path === '/mcp' || path === '/mcp/') {
        const auth = req.headers.authorization ?? ''
        const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
        if (bearer && safeEqual(bearer, token)) return await handleMcp(req, res)
      }
      const filePath = path.match(/^\/files\/([^/]+)\/(.+)$/)
      if (filePath && safeEqual(filePath[1], token) && req.method === 'GET') return await handleFile(res, filePath[2])

      // wrong / missing token and every other path look identical: nothing to probe
      return send(res, 404, 'not found')
    } catch (error) {
      log(`[bilibili-agent-mcp] ${(error as Error).message}`)
      send(res, 500, 'internal error')
    }
  })
  // tool calls such as downloads may take a while
  server.requestTimeout = 0
  server.headersTimeout = 60_000

  await new Promise<void>((ok, fail) => {
    server.once('error', fail)
    server.listen(options.port, options.host, () => ok())
  })
  return server
}
