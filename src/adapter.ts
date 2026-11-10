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
import { pluginFailure } from './errors.js'
import { CLAUDE_CODE_SESSION_ROUTE, INFERENCE_SCOPE } from './route.js'
import type { NativeRuntime } from './sdk-runtime.js'
import type { SessionManager } from './session-manager.js'
import type { SpendGate } from './spend-gate.js'

export interface AdapterDependencies {
  readonly runtime: NativeRuntime
  readonly spendGate: SpendGate
  readonly sessions: SessionManager
  readonly workspace: WorkspaceSource
  readonly auth: AuthGuard
  readonly home: HomeSource
  readonly parentEnv: () => NodeJS.ProcessEnv
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

  closeOwnedSessions(): void {
    this.dependencies.sessions.closeOwned()
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
    const session = await this.dependencies.runtime.start({
      workspace,
      model: options.model,
      systemPrompt: options.system ?? '',
    })
    await session.close()
    throw pluginFailure(
      'INCOMPATIBLE_RUNTIME',
      'The native session loop is not available. No model prompt was sent.',
    )
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

function refuseControl(name: string): never {
  throw pluginFailure('UNSUPPORTED_INPUT', `The request control "${name}" is not supported.`)
}

function blockType(block: { readonly type?: unknown }): string {
  if (typeof block.type !== 'string' || block.type.trim() === '') {
    throw pluginFailure('UNSUPPORTED_INPUT', 'A content block has no type.')
  }
  return block.type
}
