import type { MappedTool } from './mcp-bridge.js';
/**
 * Environment controls named by the Claude Code environment reference or by
 * the pinned Agent SDK declarations. Reviewed on 2026-11-10.
 * A name in this object is a requested control. It is not a measured proof
 * that a CLI build applied it.
 */
export declare const SESSION_CONTROL_ENV: {
    readonly CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1";
    readonly DISABLE_COMPACT: "1";
    readonly CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1";
    readonly CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false";
    readonly CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1";
    readonly CLAUDE_CODE_DISABLE_AGENT_VIEW: "1";
    readonly CLAUDE_CODE_DISABLE_WORKFLOWS: "1";
};
export declare const DSH_MCP_SERVER = "dsh";
/** Pinned Agent SDK package version. This is not the Claude CLI version. */
export declare const PINNED_SDK_VERSION = "0.3.322";
/**
 * One native query for one generation. The tool-call finish does not close it.
 * This plan is data. It does not import or start the Agent SDK.
 */
export interface SdkLaunchPlan {
    readonly queryCount: 1;
    readonly eventConsumers: 1;
    readonly inputQueue: 'streaming';
    readonly closeOnToolFinish: false;
    readonly cwd: string;
    readonly model: string;
    readonly systemPrompt: {
        readonly type: 'custom';
        readonly prompt: string;
        readonly snapshot: true;
    };
    readonly tools: readonly [];
    readonly settingSources: readonly [];
    readonly includePartialMessages: true;
    readonly strictMcpConfig: true;
    readonly mcpServerNames: readonly [typeof DSH_MCP_SERVER];
    readonly mcpTools: readonly {
        readonly name: string;
        readonly description: string;
        readonly parameters: Record<string, unknown>;
    }[];
    readonly mcpToolNames: readonly string[];
    readonly allowedToolNames: readonly string[];
    readonly fallbackModelOmitted: true;
    readonly plugins: readonly [];
    readonly skills: readonly [];
    readonly verbatimPrompts: true;
    readonly promptSuggestions: false;
    readonly permissionMode: 'dontAsk';
    readonly enableFileCheckpointing: false;
    readonly resumeOmitted: true;
    readonly continueConversation: false;
    readonly mcpTimeoutMs: number;
    readonly env: Readonly<Record<string, string>>;
    readonly settings: {
        readonly autoCompactEnabled: false;
        readonly precomputeCompactionEnabled: false;
        readonly idleCompaction: false;
        readonly disableClaudeAiConnectors: true;
        readonly disableBundledSkills: true;
        readonly disableAgentView: true;
        readonly disableWorkflows: true;
        readonly promptSuggestionEnabled: false;
        readonly fileCheckpointingEnabled: false;
        readonly switchModelsOnFlag: false;
        readonly fastMode: false;
    };
}
export interface SdkLaunchInput {
    readonly workspace: string;
    readonly model: string;
    readonly systemPrompt: string;
    readonly tools: readonly MappedTool[];
    readonly parentEnv: NodeJS.ProcessEnv;
    readonly home: string;
    readonly resultWaitMs: number;
}
/** Build the native session plan. Billing variables from the parent are absent. */
export declare function buildSdkLaunchPlan(input: SdkLaunchInput): SdkLaunchPlan;
