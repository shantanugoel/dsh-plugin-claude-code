import { buildChildEnvironment } from './auth.js';
import { pluginFailure } from './errors.js';
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
};
export const DSH_MCP_SERVER = 'dsh';
/** Pinned Agent SDK package version. This is not the Claude CLI version. */
export const PINNED_SDK_VERSION = '0.3.322';
/** Build the native session plan. Billing variables from the parent are absent. */
export function buildSdkLaunchPlan(input) {
    if (input.model.trim() === '') {
        throw pluginFailure('UNSUPPORTED_INPUT', 'The model id is empty.');
    }
    if (!Number.isFinite(input.resultWaitMs) || input.resultWaitMs < 1_000) {
        throw pluginFailure('INCOMPATIBLE_RUNTIME', 'The tool-result wait is below the MCP timeout floor.');
    }
    const env = {};
    for (const [name, value] of Object.entries(buildChildEnvironment(input.parentEnv, input.home))) {
        if (value !== undefined)
            env[name] = value;
    }
    for (const [name, value] of Object.entries(SESSION_CONTROL_ENV))
        env[name] = value;
    assertIsolatedEnv(env);
    const mcpTools = input.tools.map((tool) => ({
        name: tool.nativeName,
        description: tool.description,
        parameters: tool.parameters,
    }));
    const mcpToolNames = mcpTools.map((tool) => tool.name);
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
    };
}
function assertIsolatedEnv(env) {
    for (const name of Object.keys(env)) {
        if (name.startsWith('ANTHROPIC_') || name === 'CLAUDE_AGENT_SDK_CLIENT_APP') {
            throw pluginFailure('AUTH_ROUTE_REFUSED', 'The native session environment contains a billing or client-identity variable.');
        }
    }
}
