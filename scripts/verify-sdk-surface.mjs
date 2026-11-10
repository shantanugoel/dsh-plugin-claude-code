import { readFileSync } from 'node:fs'

const expectedVersion = '0.3.322'
const packageJson = JSON.parse(readFileSync(
  new URL('../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url),
  'utf8',
))
if (packageJson.version !== expectedVersion) {
  console.error(`The installed Agent SDK is ${packageJson.version}. The pinned version is ${expectedVersion}.`)
  process.exit(1)
}

const declaration = readFileSync(
  new URL('../node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts', import.meta.url),
  'utf8',
)
const required = [
  'pathToClaudeCodeExecutable',
  'includePartialMessages',
  'settingSources',
  'strictMcpConfig',
  'mcpServers',
  'export declare function query',
  'export declare function createSdkMcpServer',
  'export declare interface Query',
  'close(): void',
  'streamInput(',
  'supportedModels(',
  'prompt: string | AsyncIterable<SDKUserMessage>',
]
const missing = required.filter((needle) => !declaration.includes(needle))
if (missing.length > 0) {
  console.error(`The Agent SDK declaration does not include: ${missing.join(', ')}.`)
  process.exit(1)
}

console.log(`Agent SDK ${expectedVersion} declarations include the session, MCP, close, and model APIs.`)
