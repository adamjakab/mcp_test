import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * Configuration object passed to `McpServer.registerTool` as the second
 * argument. The SDK's `registerTool` signature is generic over the input
 * and output Zod schemas, so we mirror the shape here with the schemas
 * left loose to keep tool modules independent.
 */
export interface ToolConfig {
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
}

/**
 * Handler callback invoked when the tool is called. The SDK passes the
 * parsed input (when an `inputSchema` is declared) and request extras;
 * the returned value must conform to the SDK's `CallToolResult`.
 */
export type ToolHandler = (...args: any[]) => unknown | Promise<unknown>;

/**
 * A tool module exported by any file under `src/mcp/tools` (excluding
 * `index.ts` and `types.ts`). The tool's public name is derived from its
 * location: subfolder names joined with `_` followed by the filename
 * (without extension). For example, `generic/ping.ts` is registered as
 * `generic_ping`.
 */
export interface ToolModule {
  config: ToolConfig;
  handler: ToolHandler;
}

