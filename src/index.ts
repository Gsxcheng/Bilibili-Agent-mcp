import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer, version } from './server.js'

const main = async () => {
  const { server, client } = createServer()
  await server.connect(new StdioServerTransport())
  console.error(
    `[bilibili-agent-mcp] v${version} ready · login: ${client.loggedIn ? 'yes' : 'no'} · downloads → ${client.config.downloadDir}`,
  )
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
