/** Reversible native tool name for one dsh tool name. */
export interface ToolNameMap {
  readonly dshToNative: ReadonlyMap<string, string>
  readonly nativeToDsh: ReadonlyMap<string, string>
}

/** One staged tool result, delivered once by its exact native tool id. */
export interface StagedToolResult {
  readonly callId: string
  readonly text: string
  readonly isError: boolean
}
