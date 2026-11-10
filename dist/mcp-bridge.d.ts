import type { NativeToolResult } from './sdk-runtime.js';
export interface ToolSchemaInput {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
}
export interface MappedTool {
    readonly dshName: string;
    readonly nativeName: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
}
export interface ToolNameMap {
    readonly dshToNative: ReadonlyMap<string, string>;
    readonly nativeToDsh: ReadonlyMap<string, string>;
    readonly tools: readonly MappedTool[];
}
/**
 * Waiting tool handlers. A result is delivered only after the full dsh batch
 * is valid, and only to the exact call id.
 */
export declare class McpBridge {
    private expected;
    private readonly staged;
    private readonly waiters;
    private readonly delivered;
    private released;
    wait(callId: string, timeoutMs: number): Promise<NativeToolResult>;
    expect(callIds: readonly string[]): void;
    /**
     * Validate the whole suffix, then release staged results.
     * A bad suffix rejects no handler with a successful result.
     */
    stage(results: readonly NativeToolResult[]): void;
    /** Reject parked handlers. This does not invent a tool result. */
    cancel(message: string): void;
    get deliveryCount(): number;
}
export declare function mapToolNames(tools: readonly ToolSchemaInput[]): ToolNameMap;
