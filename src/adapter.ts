import {
  LlmAdapter,
  resolveRetryPolicy,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

import type { AuthGuard, HomeSource } from './auth.js'
import { canonicalJson, contentHash } from './canonical.js'
import { requireAbsoluteWorkspace, type WorkspaceSource } from './context.js'
import { withDeadline, type Deadlines } from './deadlines.js'
import { pluginFailure } from './errors.js'
import { McpBridge, mapToolNames } from './mcp-bridge.js'
import { projectCatalogModel } from './catalog.js'
import type { DiscoveredModel } from './model-discovery.js'
import { recordContextImport as appendContextImport } from './rebase.js'
import { parseReplay, type ReplayV1 } from './replay.js'
import { CLAUDE_CODE_SESSION_ROUTE, INFERENCE_SCOPE } from './route.js'
import { buildSdkLaunchPlan } from './sdk-plan.js'
import type { NativeRuntime } from './sdk-runtime.js'
import type { LiveGeneration, SessionManager } from './session-manager.js'
import type { Session, SessionStore } from '@deepseek-ai/dsh-session'

import type { SpendGate } from './spend-gate.js'
import { isAbortError, readUntilStop, translateTurn } from './stream.js'
import { admitTranscript, publicationFrom, requestHasReplay, type Admission } from './transcript.js'

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
  readonly configuration?: { current(): number }
  readonly catalog?: readonly DiscoveredModel[]
  readonly discoverModels?: () => Promise<readonly DiscoveredModel[]>
}

const SUPPORTED_BLOCK_TYPES = new Set(['text', 'reasoning', 'tool-call'])
const SUPPORTED_ROLES = new Set(['system', 'user', 'assistant', 'tool'])
const AUXILIARY_PURPOSES = new Set(['title', 'summary'])

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
    const decision = await this.dependencies.spendGate.decide({
      provider,
      model: 'catalog',
      purpose: 'catalog',
      identityBinding: '',
      scope: INFERENCE_SCOPE,
    })
    if (!decision.allowed) return []
    const rows = this.dependencies.catalog
      ?? (this.dependencies.discoverModels === undefined ? [] : await this.dependencies.discoverModels())
    const seen = new Set<string>()
    const models = []
    for (const row of rows) {
      if (seen.has(row.value)) continue
      seen.add(row.value)
      models.push(projectCatalogModel(provider, row))
    }
    return models
  }

  async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    this.assertRoute(provider)
    if (signal?.aborted === true) throw new DOMException('The model request was aborted.', 'AbortError')
    if (model.trim() === '') {
      throw pluginFailure('UNSUPPORTED_INPUT', 'The model id is empty.')
    }
    return { provider, id: model, name: model, inputModalities: ['text'] }
  }

  async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const resolved = await this.resolveModel(provider, model, signal)
    const generation = this.dependencies.configuration?.current() ?? 1
    return {
      model: resolved,
      stream: (options: GenerateOptions) => {
        const current = this.dependencies.configuration?.current() ?? 1
        if (current !== generation) {
          throw pluginFailure('INCOMPATIBLE_RUNTIME', 'The adapter configuration changed before dispatch.')
        }
        if (options.provider !== provider || options.model !== model) {
          throw pluginFailure('UNSUPPORTED_INPUT', 'The prepared model does not match the request.')
        }
        return this.stream(options)
      },
    }
  }

  closeOwnedSessions(): Promise<void> {
    return this.dependencies.sessions.closeOwned()
  }

  /**
   * Record one full context import, then close the live native generation.
   * An open tool call refuses the import before the session log changes.
   */
  async recordContextImport(session: Session, sessions: Pick<SessionStore, 'flush'>): Promise<string> {
    const sessionId = String(session.id)
    const live = this.dependencies.sessions.conversation(sessionId)
    if (live?.phase === 'WAITING_FOR_RESULTS' || live?.phase === 'GENERATING' || live?.phase === 'STARTING') {
      throw pluginFailure('REBASE_REQUIRED', 'The context import needs a balanced tool boundary.')
    }
    const imported = await appendContextImport({ session, sessions })
    if (live !== undefined) await this.dependencies.sessions.closeKey(live.key)
    return imported.text
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.assertRoute(options.provider)
    if (options.signal?.aborted === true) {
      if (options.sessionId !== undefined && options.purpose === undefined) {
        const existing = this.dependencies.sessions.conversation(String(options.sessionId))
        if (existing !== undefined) await this.invalidate(existing)
      }
      yield abortedFinish()
      return
    }
    assertSupportedRequest(options)
    if (options.model.trim() === '') {
      throw pluginFailure('UNSUPPORTED_INPUT', 'The model id is empty.')
    }
    if (options.sessionId === undefined) {
      throw pluginFailure('UNSUPPORTED_INPUT', 'The request has no session id.')
    }
    const sessionId = String(options.sessionId)
    const workspace = requireAbsoluteWorkspace(this.dependencies.workspace.current(sessionId))
    const auxiliary = options.purpose !== undefined
    const admitKey = auxiliary
      ? `aux:${sessionId}:${options.purpose ?? ''}:${contentHash(options.messages)}`
      : `conversation:${sessionId}`
    const existing = auxiliary ? undefined : this.dependencies.sessions.conversation(sessionId)
    if (existing?.phase === 'GENERATING' || existing?.phase === 'STARTING') {
      throw pluginFailure('SESSION_BUSY', 'This native session already has an active stream.')
    }
    this.dependencies.sessions.tryAdmit(admitKey)
    try {
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
      if (auxiliary) {
        yield* this.runAuxiliary(options, workspace, admitKey)
        return
      }
      yield* this.runAdmitted(options, workspace, sessionId)
    } finally {
      this.dependencies.sessions.endAdmit(admitKey)
    }
  }

  private async *runAuxiliary(
    options: GenerateOptions,
    workspace: string,
    key: string,
  ): AsyncIterable<StreamChunk> {
    const live = await this.ensureSession(undefined, key, options, workspace, true)
    try {
      const admission = admitTranscript({
        messages: options.messages,
        waitingForResults: false,
        state: { committed: [], pending: undefined, dispatchedHash: undefined },
      })
      if (admission.kind !== 'first-user') {
        throw pluginFailure('UNSUPPORTED_INPUT', 'An auxiliary request cannot continue a tool call.')
      }
      live.phase = 'GENERATING'
      live.dispatchedHash = admission.requestHash
      await live.native.sendUser({ text: admission.userText })
      const chunks = await this.collectTurn(live, admission, options.signal)
      live.phase = 'READY'
      for (const chunk of chunks) yield chunk
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted === true) {
        await this.invalidate(live)
        yield abortedFinish()
        return
      }
      await this.invalidate(live)
      throw error
    } finally {
      if (live.phase !== 'INVALID') await this.dependencies.sessions.closeKey(key)
    }
  }

  private async *runAdmitted(
    options: GenerateOptions,
    workspace: string,
    sessionId: string,
  ): AsyncIterable<StreamChunk> {
    let live = this.dependencies.sessions.conversation(sessionId)
    if (live?.phase === 'INVALID' || live?.phase === 'CLOSED') {
      throw pluginFailure('REBASE_REQUIRED', 'The native generation is closed. Start a recorded new generation.')
    }
    if (live === undefined && requestHasReplay(options.messages)) {
      throw pluginFailure(
        'REBASE_REQUIRED',
        'Saved replay state has no live native process. Record a context import.',
      )
    }
    const prompt = systemPromptOf(options)
    const tools = mapToolNames(options.tools ?? [])
    const toolsCanonical = canonicalJson(tools.tools)
    if (live !== undefined && (
      live.model !== options.model
      || live.workspace !== workspace
      || live.systemPrompt !== prompt
      || live.toolsCanonical !== toolsCanonical
    )) {
      throw pluginFailure('REBASE_REQUIRED', 'The model, workspace, prompt, or tools changed. Start a recorded new generation.')
    }
    const admission = admitTranscript({
      messages: options.messages,
      waitingForResults: live?.phase === 'WAITING_FOR_RESULTS',
      state: {
        committed: live?.committed ?? [],
        pending: live?.pending,
        dispatchedHash: live?.dispatchedHash,
      },
    })
    const generationId = live?.generationId ?? this.dependencies.sessions.nextGeneration(sessionId)
    const key = live?.key ?? `${sessionId}:${generationId}`
    if (live === undefined) live = await this.ensureSession(undefined, key, options, workspace, false, generationId)
    if (admission.kind === 'tool-results') {
      live.bridge.stage(admission.results)
      if (live.pending !== undefined) {
        live.pending = { ...live.pending, boundMessageId: admission.boundMessageId }
      }
    }
    live.phase = 'GENERATING'
    live.dispatchedHash = admission.requestHash
    try {
      if (admission.kind === 'tool-results') await live.native.continueAfterResults()
      else await live.native.sendUser({ text: admission.userText })
      const chunks = await this.collectTurn(live, admission, options.signal)
      if (live.pendingCalls.length > 0) live.phase = 'WAITING_FOR_RESULTS'
      else live.phase = 'READY'
      for (const chunk of chunks) yield chunk
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted === true) {
        await this.invalidate(live)
        yield abortedFinish()
        return
      }
      await this.invalidate(live)
      throw error
    }
  }

  private async collectTurn(
    live: LiveGeneration,
    admission: Admission,
    signal: AbortSignal | undefined,
  ): Promise<StreamChunk[]> {
    const events = await readUntilStop(live.iterator, live.deadlines.generationMs, signal)
    const translated = translateTurn(events, {
      nativeToDsh: live.nativeToDsh,
      dshNames: live.dshNames,
      allowedNativeTools: live.allowedNativeTools,
    })
    const replay = buildReplay(live, admission, translated.blocks, translated.nativeBlocks, translated.evidence, translated.auditAccepted)
    const publication = publicationFrom({
      blocks: translated.blocks,
      nativeMessageIds: translated.nativeMessageIds,
      replay,
      callIds: translated.pendingCalls.map((call) => call.id),
    })
    live.committed = admission.committed
    live.pending = publication
    live.pendingCalls = translated.pendingCalls
    if (translated.pendingCalls.length > 0) {
      live.bridge.expect(translated.pendingCalls.map((call) => call.id))
    }
    return [
      ...translated.chunks,
      {
        type: 'finish',
        reason: translated.stopReason === 'tool_use' ? { kind: 'tool-calls' } : { kind: 'stop' },
        replayState: { response: replay },
      },
    ]
  }

  private async ensureSession(
    live: LiveGeneration | undefined,
    key: string,
    options: GenerateOptions,
    workspace: string,
    auxiliary: boolean,
    generationId = 'aux',
  ): Promise<LiveGeneration> {
    if (live !== undefined) return live
    const bridge = new McpBridge()
    const tools = mapToolNames(options.tools ?? [])
    const prompt = systemPromptOf(options)
    const launch = buildSdkLaunchPlan({
      workspace,
      model: options.model,
      systemPrompt: prompt,
      tools: tools.tools,
      parentEnv: this.dependencies.parentEnv(),
      home: this.dependencies.home.current(),
      resultWaitMs: this.dependencies.deadlines.resultWaitMs,
    })
    const native = await withDeadline(this.dependencies.runtime.start({
      workspace,
      model: options.model,
      systemPrompt: prompt,
      launch,
      callTool: (callId) => bridge.wait(callId, this.dependencies.deadlines.resultWaitMs),
    }), this.dependencies.deadlines.initializationMs, 'INCOMPATIBLE_RUNTIME', 'The native session did not initialize before the deadline.')
    const created: LiveGeneration = {
      key,
      sessionId: String(options.sessionId),
      generationId,
      auxiliary,
      phase: 'STARTING',
      native,
      bridge,
      iterator: native.events[Symbol.asyncIterator](),
      model: options.model,
      workspace,
      systemPrompt: prompt,
      toolsCanonical: canonicalJson(tools.tools),
      toolNameMap: Object.fromEntries(tools.dshToNative),
      nativeToDsh: tools.nativeToDsh,
      dshNames: new Set(tools.dshToNative.keys()),
      allowedNativeTools: new Set(launch.allowedToolNames),
      deadlines: this.dependencies.deadlines,
      pendingCalls: [],
      committed: [],
      pending: undefined,
      dispatchedHash: undefined,
    }
    this.dependencies.sessions.insert(created)
    return created
  }

  private async invalidate(live: LiveGeneration): Promise<void> {
    live.phase = 'INVALID'
    live.bridge.cancel('The native session closed before the tool result was delivered.')
    await live.native.close()
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

function assertSupportedRequest(options: GenerateOptions): void {
  if (options.temperature !== undefined) refuseControl('temperature')
  if (options.maxTokens !== undefined) refuseControl('maxTokens')
  if (options.reasoningEffort !== undefined) refuseControl('reasoningEffort')
  if (options.stop !== undefined && options.stop.length > 0) refuseControl('stop')
    if (options.purpose !== undefined && !AUXILIARY_PURPOSES.has(options.purpose)) {
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
    if (!SUPPORTED_ROLES.has(message.role)) {
      throw pluginFailure('UNSUPPORTED_INPUT', `The message role "${message.role}" is not supported.`)
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

function abortedFinish(): StreamChunk {
  const failure = pluginFailure(
    'NATIVE_OUTCOME_UNKNOWN',
    'The model request was aborted. No tool result was invented.',
  )
  return { type: 'finish', reason: { kind: 'aborted', failure: failure.failure } }
}

function buildReplay(
  live: LiveGeneration,
  admission: Admission,
  blocks: readonly unknown[],
  nativeBlocks: readonly unknown[],
  evidence: unknown,
  auditAccepted: boolean,
): ReplayV1 {
  return parseReplay({
    format: 'claude-session-v1',
    generationId: live.generationId,
    cliSessionId: live.native.identity.cliSessionId,
    cliVersion: live.native.identity.cliVersion,
    sdkVersion: live.native.identity.sdkVersion,
    model: live.model,
    workspace: live.workspace,
    requestPrefixHash: admission.requestHash,
    projectedContentHash: contentHash(blocks),
    nativeRequestRecord: auditAccepted ? evidence : null,
    nativeResponseBlocks: nativeBlocks,
    toolNameMap: live.toolNameMap,
    retentionAudit: auditAccepted ? 'accepted' : 'unavailable',
  })
}

function blockType(block: { readonly type?: unknown }): string {
  if (typeof block.type !== 'string' || block.type.trim() === '') {
    throw pluginFailure('UNSUPPORTED_INPUT', 'A content block has no type.')
  }
  return block.type
}
