import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildChildEnvironment } from './auth.js'
import { withDeadline } from './deadlines.js'
import { findClaudeExecutable } from './official-session.js'

export interface DiscoveredModel {
  readonly value: string
  readonly displayName: string
  readonly description?: string
}

const FAILURE_TTL_MS = 30_000

/**
 * Process-wide catalog. A successful read is kept. A failed read is empty
 * until the short retry interval passes. The read does not send a user prompt.
 */
export const officialModelDiscovery = {
  list(): Promise<readonly DiscoveredModel[]> {
    return cachedDiscovery()
  },
}

let cached: readonly DiscoveredModel[] | undefined
let failedAt = 0
let pending: Promise<readonly DiscoveredModel[]> | undefined

async function cachedDiscovery(): Promise<readonly DiscoveredModel[]> {
  if (cached !== undefined) return cached
  if (Date.now() - failedAt < FAILURE_TTL_MS) return []
  if (pending === undefined) {
    pending = readOfficialModels().then((rows) => {
      cached = rows
      return rows
    }).catch(() => {
      failedAt = Date.now()
      return []
    }).finally(() => {
      pending = undefined
    })
  }
  return pending
}

async function readOfficialModels(): Promise<readonly DiscoveredModel[]> {
  const env = buildChildEnvironment(process.env, homedir())
  const executable = findClaudeExecutable(env['PATH'])
  const sdk = await import('@anthropic-ai/claude-agent-sdk')
  let closed = false
  let wake: (() => void) | undefined
  const prompt = {
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        await new Promise<void>((resolve) => {
          if (closed) resolve()
          else wake = resolve
        })
      }
    },
  }
  const query = sdk.query({
    prompt,
    options: {
      cwd: mkdtempSync(join(tmpdir(), 'dsh-claude-models-')),
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      plugins: [],
      skills: [],
      includePartialMessages: false,
      env,
      pathToClaudeCodeExecutable: executable,
    },
  })
  try {
    const models = await withDeadline(
      query.supportedModels(),
      30_000,
      'INCOMPATIBLE_RUNTIME',
      'Claude model discovery did not finish.',
    )
    return models.flatMap((model) => {
      const value = model.value.trim()
      if (value === '' || value !== model.value.trim()) return []
      const description = model.description.trim()
      return [{
        value,
        displayName: model.displayName.trim() === '' ? value : model.displayName,
        ...(description === '' ? {} : { description }),
      }]
    })
  } finally {
    closed = true
    wake?.()
    query.close()
  }
}
