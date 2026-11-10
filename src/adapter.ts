import {
  LlmAdapter,
  resolveRetryPolicy,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

import type { AuthGuard, HomeSource } from './auth.js'
import { requireAbsoluteWorkspace, type WorkspaceSource } from './context.js'
import { withDeadline, type Deadlines } from './deadlines.js'
import { pluginFailure } from './errors.js'
import { McpBridge, mapToolNames } from './mcp-bridge.js'
import { CLAUDE_CODE_SESSION_ROUTE, INFERENCE_SCOPE } from './route.js'
import { buildSdkLaunchPlan } from './sdk-plan.js'
import type { NativeRuntime } from './sdk-runtime.js'
import type { LiveGeneration, SessionManager } from './session-manager.js'
import type { SpendGate } from './spend-gate.js'
import { readUntilStop, translateTurn } from './stream.js'
import { latestUserText, trailingToolResults } from './transcript.js'

export interface AdapterDependencies {
  readonly runtime: NativeRuntime
  readonly spendGate: SpendGate
  readonly sessions: SessionManager
  readonly workspace: WorkspaceSource
  readonly auth: AuthGuard
  readonly home: HomeSource
  readonly parentEnv: () => NodeJS.ProcessEnv
  readonly deadlines: Deadlines
  readonly settingsFiles?: () => readonly string[]
}

const SUPPORTED_BLOCK_TYPES = new Set(['text', 'reasoning', 'tool-call'])

/**
 * dsh adapter for route `claude-code-session`.
 * A model prompt cannot leave this object while the spend gate refuses.
 */
export class ClaudeCodeAdapter extends LlmAdapter {
  private readonly retryPolicy: ResolvedRetryPolicy

  constructor(private readonly dependencies: AdapterDependencies) {
    super()
    this.retryPolicy = resolveRetryPolicy(
      {
        mode: 'normal',
        maxRetries: 0,
        retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
      },
      `${CLAUDE_CODE_SESSION_ROUTE}.retryPolicy`,
    )
  }

  providerInfo(provider: string): LlmProviderInfo {
    this.assertRoute(provider)
    return { id: provider, name: 'Claude Code session' }
  }

  providerRetryPolicy(provider: string): ResolvedRetryPolicy {
    this.assertRoute(provider)
    return this.retryPolicy
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    this.assertRoute(provider)
    return []
  }

  async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    this.assertRoute(provider)
    throwIfAborted(signal)
    if (model.trim() === '') {
      throw pluginFailure('UNSUPPORTED_INPUT', 'The model id is empty.')
    }
    return { provider, id: model, name: model }
  }

  closeOwnedSessions(): Promise<void> {
    return this.dependencies.sessions.closeOwned()
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.assertRoute(options.provider)
    throwIfAborted(options.signal)
    assertSupportedRequest(options)
    if (options.model.trim() === '') {
      throw pluginFailure('UNSUPPORTED_INPUT', 'The model id is empty.')
    }
    const workspace = requireAbsoluteWorkspace(this.dependencies.workspace.current())
    const settingsFiles = this.dependencies.settingsFiles?.()
    const acceptance = await this.dependencies.auth.check({
      workspace,
      home: this.dependencies.home.current(),
      parentEnv: this.dependencies.parentEnv(),
      ...(settingsFiles === undefined ? {} : { settingsFiles }),
    })
    const decision = await this.dependencies.spendGate.decide({
      provider: options.provider,
      model: options.model,
      purpose: options.purpose ?? 'conversation',
      identityBinding: acceptance.identityBinding,
      scope: INFERENCE_SCOPE,
    })
    if (!decision.allowed) {
      throw pluginFailure(
        decision.code,
        'No accepted spend guard can prevent a paid request. No model prompt was sent.',
      )
    }
    yield* this.runAdmitted(options, workspace)
  }

  private async *runAdmitted(options: GenerateOptions, workspace: string): AsyncIterable<StreamChunk> {
    if (options.sessionId === undefined) {
      throw pluginFailure('UNSUPPORTED_INPUT', 'The request has no session id.')
    }
    const key = `${String(options.sessionId)}:1`
    let live = this.dependencies.sessions.get(key)
    if (live?.phase === 'GENERATING' || live?.phase === 'STARTING') {
      throw pluginFailure('SESSION_BUSY', 'This native session already has an active stream.')
    }
    if (live?.phase === 'INVALID' || live?.phase === 'CLOSED') {
      throw pluginFailure('REBASE_REQUIRED', 'The native generation is closed. Start a recorded new generation.')
    }
    if (live !== undefined && (live.model !== options.model || live.workspace !== workspace)) {
      throw pluginFailure('REBASE_REQUIRED', 'The model or workspace changed. Start a recorded new generation.')
    }
    if (live?.phase === 'WAITING_FOR_RESULTS') {
      this.releaseResults(live, options)
      await live.native.continueAfterResults()
      live.phase = 'GENERATING'
    } else {
      live = await this.ensureSession(live, key, options, workspace)
      live.phase = 'GENERATING'
      await live.native.sendUser({ text: latestUserText(options.messages) })
    }
    let translated
    try {
      const events = await readUntilStop(live.iterator, live.deadlines.generationMs)
      const tools = mapToolNames(options.tools ?? [])
      translated = translateTurn(events, {
      format: 'claude-session-v1',
      generationId: '1',
      model: options.model,
      workspace,
      toolNameMap: Object.fromEntries(tools.dshToNative),
      nativeResponseBlocks: events,
    })
    } catch (error) {
      live.phase = 'INVALID'
      await live.native.close()
      throw error
    }
    if (translated.pendingCalls.length > 0) {
      live.bridge.expect(translated.pendingCalls.map((call) => call.id))
      live.pendingCalls = translated.pendingCalls
      live.phase = 'WAITING_FOR_RESULTS'
    } else {
      live.pendingCalls = []
      live.phase = 'READY'
    }
    for (const chunk of translated.chunks) yield chunk
  }

  private releaseResults(live: LiveGeneration, options: GenerateOptions): void {
    const suffix = trailingToolResults(options.messages)
    if (suffix.endsWithUser) {
      throw pluginFailure(
        'UNSUPPORTED_INPUT',
        'A user message cannot enter a tool-result suffix.',
      )
    }
    live.bridge.stage(suffix.results.map((result) => ({
      callId: result.callId,
      text: result.text,
      isError: result.isError,
    })))
  }

  private async ensureSession(
    live: LiveGeneration | undefined,
    key: string,
    options: GenerateOptions,
    workspace: string,
  ): Promise<LiveGeneration> {
    if (live !== undefined) return live
    const bridge = new McpBridge()
    const tools = mapToolNames(options.tools ?? [])
    const launch = buildSdkLaunchPlan({
      workspace,
      model: options.model,
      systemPrompt: systemPromptOf(options),
      tools: tools.tools,
      parentEnv: this.dependencies.parentEnv(),
      home: this.dependencies.home.current(),
      resultWaitMs: this.dependencies.deadlines.resultWaitMs,
    })
    const native = await withDeadline(this.dependencies.runtime.start({
      workspace,
      model: options.model,
      systemPrompt: systemPromptOf(options),
      launch,
      callTool: (callId) => bridge.wait(callId, this.dependencies.deadlines.resultWaitMs),
    }), this.dependencies.deadlines.initializationMs, 'INCOMPATIBLE_RUNTIME', 'The native session did not initialize before the deadline.')
    const created: LiveGeneration = {
      key,
      phase: 'STARTING',
      native,
      bridge,
      iterator: native.events[Symbol.asyncIterator](),
      model: options.model,
      workspace,
      deadlines: this.dependencies.deadlines,
      pendingCalls: [],
    }
    this.dependencies.sessions.insert(created)
    return created
  }

  private assertRoute(provider: string): void {
    if (provider !== CLAUDE_CODE_SESSION_ROUTE) {
      throw pluginFailure(
        'INCOMPATIBLE_RUNTIME',
        `The provider route "${provider}" is not ${CLAUDE_CODE_SESSION_ROUTE}.`,
      )
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  const reason = signal.reason
  if (reason instanceof Error) throw reason
  throw new DOMException('The model request was aborted.', 'AbortError')
}

function assertSupportedRequest(options: GenerateOptions): void {
  if (options.temperature !== undefined) refuseControl('temperature')
  if (options.maxTokens !== undefined) refuseControl('maxTokens')
  if (options.reasoningEffort !== undefined) refuseControl('reasoningEffort')
  if (options.stop !== undefined && options.stop.length > 0) refuseControl('stop')
  if (options.purpose !== undefined) {
    throw pluginFailure('UNSUPPORTED_INPUT', 'This request purpose has no isolated mapping.')
  }
  if (options.toolHistory !== undefined) {
    throw pluginFailure('UNSUPPORTED_INPUT', 'Tool history updates are not supported for this route.')
  }
  const hasSystemMessage = options.messages.some((message) => message.role === 'system')
  if (options.system !== undefined && hasSystemMessage) {
    throw pluginFailure(
      'UNSUPPORTED_INPUT',
      'The request has both a system field and a system message.',
    )
  }
  for (const message of options.messages) {
    if (message.role === 'developer') {
      throw pluginFailure('UNSUPPORTED_INPUT', 'A developer message is not supported for this route.')
    }
    for (const block of message.content) {
      const type = blockType(block)
      if (!SUPPORTED_BLOCK_TYPES.has(type)) {
        throw pluginFailure('UNSUPPORTED_INPUT', `The content type "${type}" is not supported.`)
      }
    }
  }
}

function systemPromptOf(options: GenerateOptions): string {
  if (options.system !== undefined) return options.system
  const system = options.messages.find((message) => message.role === 'system')
  if (system === undefined) return ''
  const parts: string[] = []
  for (const block of system.content) {
    if (block.type !== 'text' || typeof block.text !== 'string') {
      throw pluginFailure('UNSUPPORTED_INPUT', 'The system message contains unsupported content.')
    }
    parts.push(block.text)
  }
  return parts.join('')
}

function refuseControl(name: string): never {
  throw pluginFailure('UNSUPPORTED_INPUT', `The request control "${name}" is not supported.`)
}

function blockType(block: { readonly type?: unknown }): string {
  if (typeof block.type !== 'string' || block.type.trim() === '') {
    throw pluginFailure('UNSUPPORTED_INPUT', 'A content block has no type.')
  }
  return block.type
}
