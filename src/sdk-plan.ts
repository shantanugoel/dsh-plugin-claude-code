import { buildChildEnvironment } from './auth.js'
import type { ClaudeEffort } from './effort.js'
import { pluginFailure } from './errors.js'
import type { MappedTool } from './mcp-bridge.js'

/**
 * Environment controls named by the Claude Code environment reference or by
 * the pinned Agent SDK declarations. Reviewed on 2026-11-10.
 * A name in this object is a requested control. It is not a measured proof
 * that a CLI build applied it.
 */
export const SESSION_CONTROL_ENV = {
  CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1',
  DISABLE_COMPACT: '1',
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
  CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
  CLAUDE_CODE_DISABLE_WORKFLOWS: '1',
  // Measured on CLI 2.1.319: an incremental request body sends only the delta
  // and a thread reference, so a later request has no complete message prefix.
  // The plugin needs each request body complete for its retention audit.
  CLAUDE_CODE_INCREMENTAL_REQUEST_BODY: '0',
} as const

export const DSH_MCP_SERVER = 'dsh'

/** Pinned Agent SDK package version. This is not the Claude CLI version. */
export const PINNED_SDK_VERSION = '0.3.322'

/**
 * One native query for one generation. The tool-call finish does not close it.
 * This plan is data. It does not import or start the Agent SDK.
 */
export interface SdkLaunchPlan {
  readonly queryCount: 1
  readonly eventConsumers: 1
  readonly inputQueue: 'streaming'
  readonly closeOnToolFinish: false
  readonly cwd: string
  readonly model: string
  readonly systemPrompt: {
    readonly type: 'custom'
    readonly prompt: string
    readonly snapshot: true
  }
  readonly tools: readonly []
  readonly settingSources: readonly []
  readonly includePartialMessages: true
  readonly strictMcpConfig: true
  readonly mcpServerNames: readonly [typeof DSH_MCP_SERVER]
  readonly mcpTools: readonly {
    readonly name: string
    readonly description: string
    readonly parameters: Record<string, unknown>
  }[]
  readonly mcpToolNames: readonly string[]
  readonly allowedToolNames: readonly string[]
  readonly fallbackModelOmitted: true
  readonly plugins: readonly []
  readonly skills: readonly []
  readonly verbatimPrompts: true
  readonly promptSuggestions: false
  readonly permissionMode: 'dontAsk'
  readonly effort?: ClaudeEffort
  readonly maxOutputTokens?: number
  /** Private directory of the CLI raw request-body diagnostic for this generation. */
  readonly diagnosticsDir?: string
  /** The dsh MCP tools are never deferred behind tool search. */
  readonly mcpAlwaysLoad: true
  readonly enableFileCheckpointing: false
  readonly resumeOmitted: true
  readonly continueConversation: false
  readonly mcpTimeoutMs: number
  readonly env: Readonly<Record<string, string>>
  readonly settings: {
    readonly autoCompactEnabled: false
    readonly precomputeCompactionEnabled: false
    readonly idleCompaction: false
    readonly disableClaudeAiConnectors: true
    readonly disableBundledSkills: true
    readonly disableAgentView: true
    readonly disableWorkflows: true
    readonly promptSuggestionEnabled: false
    readonly fileCheckpointingEnabled: false
    readonly switchModelsOnFlag: false
    readonly fastMode: false
  }
}

export interface SdkLaunchInput {
  readonly workspace: string
  readonly model: string
  readonly systemPrompt: string
  readonly tools: readonly MappedTool[]
  readonly parentEnv: NodeJS.ProcessEnv
  readonly home: string
  readonly resultWaitMs: number
  readonly effort?: ClaudeEffort
  readonly maxOutputTokens?: number
  /** When set, the native child writes its raw `/v1/messages` bodies to this private directory. */
  readonly diagnosticsDir?: string
}

/** Build the native session plan. Billing variables from the parent are absent. */
export function buildSdkLaunchPlan(input: SdkLaunchInput): SdkLaunchPlan {
  if (input.model.trim() === '') {
    throw pluginFailure('UNSUPPORTED_INPUT', 'The model id is empty.')
  }
  if (!Number.isFinite(input.resultWaitMs) || input.resultWaitMs < 1_000) {
    throw pluginFailure('INCOMPATIBLE_RUNTIME', 'The tool-result wait is below the MCP timeout floor.')
  }
  if (input.maxOutputTokens !== undefined
    && (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1)) {
    throw pluginFailure('UNSUPPORTED_INPUT', 'The maxTokens control must be a positive integer.')
  }
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(buildChildEnvironment(input.parentEnv, input.home))) {
    if (value !== undefined) env[name] = value
  }
  for (const [name, value] of Object.entries(SESSION_CONTROL_ENV)) env[name] = value
  if (input.maxOutputTokens !== undefined) {
    env['CLAUDE_CODE_MAX_OUTPUT_TOKENS'] = String(input.maxOutputTokens)
  }
  if (input.diagnosticsDir !== undefined) {
    // Official Claude Code diagnostic. One full `/v1/messages` request body and one
    // response body for each call. The directory is private and owned by the plugin.
    env['OTEL_LOG_RAW_API_BODIES'] = `file:${input.diagnosticsDir}`
  }
  assertIsolatedEnv(env)
  const mcpTools = input.tools.map((tool) => ({
    name: tool.nativeName,
    description: tool.description,
    parameters: tool.parameters,
  }))
  const mcpToolNames = mcpTools.map((tool) => tool.name)
  return {
    queryCount: 1,
    eventConsumers: 1,
    inputQueue: 'streaming',
    closeOnToolFinish: false,
    cwd: input.workspace,
    model: input.model,
    systemPrompt: { type: 'custom', prompt: input.systemPrompt, snapshot: true },
    tools: [],
    settingSources: [],
    includePartialMessages: true,
    strictMcpConfig: true,
    mcpServerNames: [DSH_MCP_SERVER],
    mcpTools,
    mcpToolNames,
    allowedToolNames: mcpToolNames.map((name) => `mcp__${DSH_MCP_SERVER}__${name}`),
    fallbackModelOmitted: true,
    plugins: [],
    skills: [],
    verbatimPrompts: true,
    promptSuggestions: false,
    permissionMode: 'dontAsk',
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    ...(input.maxOutputTokens === undefined ? {} : { maxOutputTokens: input.maxOutputTokens }),
    ...(input.diagnosticsDir === undefined ? {} : { diagnosticsDir: input.diagnosticsDir }),
    mcpAlwaysLoad: true,
    enableFileCheckpointing: false,
    resumeOmitted: true,
    continueConversation: false,
    mcpTimeoutMs: input.resultWaitMs,
    env,
    settings: {
      autoCompactEnabled: false,
      precomputeCompactionEnabled: false,
      idleCompaction: false,
      disableClaudeAiConnectors: true,
      disableBundledSkills: true,
      disableAgentView: true,
      disableWorkflows: true,
      promptSuggestionEnabled: false,
      fileCheckpointingEnabled: false,
      switchModelsOnFlag: false,
      fastMode: false,
    },
  }
}

function assertIsolatedEnv(env: Readonly<Record<string, string>>): void {
  for (const name of Object.keys(env)) {
    if (name.startsWith('ANTHROPIC_') || name === 'CLAUDE_AGENT_SDK_CLIENT_APP') {
      throw pluginFailure(
        'AUTH_ROUTE_REFUSED',
        'The native session environment contains a billing or client-identity variable.',
      )
    }
  }
}
