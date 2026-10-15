import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { loadConfig } from './config.js'
import { loadEnvFiles } from './env-file.js'
import { BiliClient } from './http.js'
import { resolveToken, startHttpServer } from './http-server.js'
import { createServer, version } from './server.js'

const HELP = `bilibili-agent-mcp v${version}

用法:
  bilibili-agent-mcp                 本地 stdio 模式（Claude Desktop / Claude Code / Cursor 配置里用）
  bilibili-agent-mcp --http          远程 HTTP 模式（Claude / ChatGPT 网页版连接器，配合 Cloudflare Tunnel）

HTTP 模式选项:
  --port <端口>        默认 8787（或环境变量 BILIBILI_MCP_PORT）
  --host <地址>        默认 127.0.0.1，只接受本机（隧道）连接；BILIBILI_MCP_HOST
  --public-url <URL>   对外地址，用于生成文件下载链接；默认从请求头自动识别；BILIBILI_MCP_PUBLIC_URL
  --show-token         只打印访问密钥后退出

访问密钥: 环境变量 BILIBILI_MCP_TOKEN；未设置时自动生成并保存在 ~/.bilibili-agent-mcp/token
`

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const has = (name: string) => process.argv.includes(name)

const main = async () => {
  const envFiles = loadEnvFiles()
  if (has('--help') || has('-h')) {
    process.stdout.write(HELP)
    return
  }
  if (has('--version') || has('-v')) {
    process.stdout.write(`${version}\n`)
    return
  }
  if (has('--show-token')) {
    const { token, source } = await resolveToken()
    process.stdout.write(`${token}\n`)
    console.error(`(来源: ${source})`)
    return
  }

  const wantHttp = has('--http') || /^https?$/i.test(process.env.BILIBILI_MCP_TRANSPORT ?? '')
  if (!wantHttp) {
    const { server, client } = createServer()
    await server.connect(new StdioServerTransport())
    console.error(
      `[bilibili-agent-mcp] v${version} stdio ready · login: ${client.loggedIn ? 'yes' : 'no'} · downloads → ${client.config.downloadDir}`,
    )
    return
  }

  const client = new BiliClient(loadConfig())
  const port = Number(arg('--port') ?? process.env.BILIBILI_MCP_PORT ?? 8787)
  const host = arg('--host') ?? process.env.BILIBILI_MCP_HOST ?? '127.0.0.1'
  const publicUrl = arg('--public-url') ?? process.env.BILIBILI_MCP_PUBLIC_URL
  const { token, source } = await resolveToken()
  await startHttpServer(client, { host, port, token, publicUrl })

  const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  const lines = [
    `[bilibili-agent-mcp] v${version} HTTP 模式已启动`,
    `  B站登录: ${client.loggedIn ? '已配置 Cookie' : '未配置（游客模式）'} · 下载目录: ${client.config.downloadDir}`,
    `  本机测试地址: http://${shownHost}:${port}/mcp/${token}`,
    publicUrl
      ? `  连接器地址:   ${publicUrl.replace(/\/+$/, '')}/mcp/${token}`
      : `  连接器地址:   https://<你的隧道域名>/mcp/${token}`,
    `  配置文件:     ${envFiles.length ? envFiles.join(', ') : '无（使用环境变量）'}`,
    `  访问密钥来源: ${source === 'env' ? '环境变量 BILIBILI_MCP_TOKEN' : source}`,
    '  ⚠ 连接器地址等同于密码，知道它的人可以用你的 B 站账号查数据，请勿外泄。',
  ]
  if (host === '0.0.0.0' || host === '::') {
    lines.push('  ⚠ 当前监听所有网卡；使用 Cloudflare Tunnel 时建议保持默认 127.0.0.1。')
  }
  console.error(lines.join('\n'))
}

main().catch(error => {
  console.error(`[bilibili-agent-mcp] 启动失败: ${(error as Error).message}`)
  process.exit(1)
})
