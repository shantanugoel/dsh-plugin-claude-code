import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildChildEnvironment } from './auth.js'
import { contextWindowFromUsage } from './capacity.js'
import { withDeadline } from './deadlines.js'
import { recordedEffortLevels, type ClaudeEffort } from './effort.js'
import { findClaudeExecutable } from './official-session.js'

export interface DiscoveredModel {
  readonly value: string
  readonly displayName: string
  readonly description?: string
  readonly supportsEffort?: boolean
  readonly supportedEffortLevels?: readonly ClaudeEffort[]
}

/** Deadline of one context-window read. The read sends no model request. */
const WINDOW_READ_MS = 10_000

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
      const supportedEffortLevels = recordedEffortLevels(model.supportedEffortLevels)
      return [{
        value,
        displayName: model.displayName.trim() === '' ? value : model.displayName,
        ...(description === '' ? {} : { description }),
        ...(model.supportsEffort === true
          ? { supportsEffort: true, supportedEffortLevels }
          : {}),
      }]
    })
  } finally {
    closed = true
    wake?.()
    query.close()
  }
}

/** Reads the context window of one model. A failed read returns undefined. */
export interface ContextWindowReader {
  read(model: string): Promise<number | undefined>
}

/**
 * Cache one window for each model id. A successful read is kept for the
 * process lifetime. A failed read is retried after the short retry interval.
 * The reads run one at a time, so a model list does not start many CLI
 * processes together.
 */
export function createContextWindowReader(
  readOne: (model: string) => Promise<number | undefined>,
  now: () => number = Date.now,
): ContextWindowReader {
  const known = new Map<string, number>()
  const failedAtByModel = new Map<string, number>()
  const pendingByModel = new Map<string, Promise<number | undefined>>()
  let chain: Promise<unknown> = Promise.resolve()
  return {
    read(model) {
      const value = known.get(model)
      if (value !== undefined) return Promise.resolve(value)
      const failed = failedAtByModel.get(model)
      if (failed !== undefined && now() - failed < FAILURE_TTL_MS) return Promise.resolve(undefined)
      const active = pendingByModel.get(model)
      if (active !== undefined) return active
      const next = chain.then(() => readOne(model)).catch(() => undefined).then((window) => {
        if (window === undefined) failedAtByModel.set(model, now())
        else known.set(model, window)
        pendingByModel.delete(model)
        return window
      })
      chain = next
      pendingByModel.set(model, next)
      return next
    },
  }
}

/** Process-wide context windows that the official CLI reports. */
export const officialContextWindows: ContextWindowReader = createContextWindowReader(readOfficialContextWindow)

/**
 * Start the CLI with this model, read its summary context report, and close.
 * The session has no user prompt, and the summary report uses local values, so
 * the read sends no model request. It does not call `setModel`.
 */
async function readOfficialContextWindow(model: string): Promise<number | undefined> {
  // Native compaction is off in each generation. Use the same controls here, so
  // the CLI reports the window of the model and not a compaction window.
  const env: Record<string, string> = { ...buildChildEnvironment(process.env, homedir()), DISABLE_COMPACT: '1' }
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
      cwd: mkdtempSync(join(tmpdir(), 'dsh-claude-window-')),
      model,
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      plugins: [],
      skills: [],
      includePartialMessages: false,
      env,
      settings: { autoCompactEnabled: false, precomputeCompactionEnabled: false, idleCompaction: false },
      pathToClaudeCodeExecutable: executable,
    },
  })
  try {
    const usage = await withDeadline(
      query.getContextUsage({ detail: 'summary' }),
      WINDOW_READ_MS,
      'INCOMPATIBLE_RUNTIME',
      'The context window read did not finish.',
    )
    return contextWindowFromUsage(usage)
  } finally {
    closed = true
    wake?.()
    query.close()
  }
}
