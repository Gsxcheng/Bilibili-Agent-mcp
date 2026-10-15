import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createRequire } from 'node:module'
import { loadConfig } from './config.js'
import { BiliClient, FetchLike } from './http.js'
import { registerTools, ToolContext } from './tools.js'

export const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

const INSTRUCTIONS =
  'B站（bilibili）工具集，部分功能移植自浏览器脚本 Bilibili-Evolved。所有视频类工具都接受链接、BV号、av号、ep号或 b23.tv 短链。' +
  '总结/理解视频内容时优先用 bili_subtitles(format=text)，再用 bili_danmaku(mode=stats) 了解观众反应。' +
  '需要登录的数据（高清晰度、AI 字幕、稍后再看、收藏、历史、动态）依赖服务端配置的 BILIBILI_COOKIE。' +
  '工具结果里如有 downloadUrl，可把该链接交给用户下载文件。'

/** Build an MCP server instance on top of an existing client (shared across HTTP requests). */
export const buildServer = (client: BiliClient, context: ToolContext = {}) => {
  const server = new McpServer({ name: 'bilibili-agent-mcp', version }, { instructions: INSTRUCTIONS })
  registerTools(server, client, context)
  return server
}

export const createServer = (env: NodeJS.ProcessEnv = process.env, fetchImpl?: FetchLike) => {
  const config = loadConfig(env)
  const client = new BiliClient(config, fetchImpl)
  return { server: buildServer(client), client }
}
