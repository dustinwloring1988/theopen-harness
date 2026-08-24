import { createInterface } from 'node:readline'

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function handle(message) {
  switch (message.method) {
    case 'initialize':
      respond(message.id, {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: 'mcp-fixture-server', version: '0.0.1' },
      })
      break
    case 'tools/list':
      respond(message.id, {
        tools: [{
          name: 'noop',
          description: 'Fixture no-op tool.',
          inputSchema: { type: 'object', properties: {} },
        }],
      })
      break
    case 'prompts/list':
      respond(message.id, {
        prompts: [{
          name: 'review_pull_request',
          description: 'Review the open pull request',
          arguments: [{ name: 'pr', description: 'Pull request number', required: true }],
        }],
      })
      break
    case 'prompts/get':
      respond(message.id, {
        messages: [
          { role: 'user', content: { type: 'text', text: 'Review the open pull request.' } },
          { role: 'assistant', content: { type: 'text', text: 'I reviewed the pull request.' } },
        ],
      })
      break
    default:
      if (message.id !== undefined && message.id !== null) {
        process.stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Method not found: ${String(message.method)}` },
        })}\n`)
      }
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim().length === 0) return
  handle(JSON.parse(line))
}).on('close', () => {
  process.exit(0)
})
