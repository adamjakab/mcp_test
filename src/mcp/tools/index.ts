import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolHandler, ToolModule } from "../../types/tool";

// Files that exist alongside tools but must never be registered as tools.
const RESERVED_BASENAMES = new Set(["index", "types"]);

const requireToolModule = createRequire(__filename);

type DiscoveredTool = {
  name: string;
  filePath: string;
};

/**
 * Recursively walk the tools directory and return every tool module file
 * along with its dotted name. The name is derived from the path relative
 * to `baseDir`: subfolder segments joined with `.` followed by the file
 * basename (without extension). For example, `generic/ping.ts` becomes
 * `generic.ping`.
 */
const discoverToolFiles = (
  baseDir: string,
  moduleExt: string,
  currentDir: string = baseDir,
): DiscoveredTool[] => {
  const discovered: DiscoveredTool[] = [];

  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const entryPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      discovered.push(...discoverToolFiles(baseDir, moduleExt, entryPath));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!entry.name.endsWith(moduleExt) || entry.name.endsWith(".d.ts")) {
      continue;
    }

    const basename = entry.name.slice(0, -moduleExt.length);
    if (RESERVED_BASENAMES.has(basename)) {
      continue;
    }

    const relative = path.relative(baseDir, entryPath);
    const withoutExt = relative.slice(0, -moduleExt.length);
    const segments = withoutExt.split(path.sep).filter(Boolean);
    const name = segments.join(".");

    discovered.push({ name, filePath: entryPath });
  }

  return discovered;
};

const isToolModule = (value: unknown): value is ToolModule => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<ToolModule>;
  return (
    typeof candidate.config === "object" &&
    candidate.config !== null &&
    typeof candidate.handler === "function"
  );
};

const loadToolModule = (filePath: string): ToolModule | undefined => {
  const imported = requireToolModule(filePath) as Record<string, unknown> & {
    default?: unknown;
  };

  if (isToolModule(imported.tool)) {
    return imported.tool;
  }

  if (isToolModule(imported.default)) {
    return imported.default;
  }

  return undefined;
};

const stringifyForLog = (value: unknown): string => {
  if (value === undefined) {
    return "undefined";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
};

/**
 * Wrap a tool handler so every invocation is logged with its dotted name,
 * arguments, duration and outcome. The original handler signature is
 * preserved so the SDK still sees the same callable shape.
 */
const withInvocationLogging = (
  name: string,
  handler: ToolHandler,
): ToolHandler => {
  return async (...args: unknown[]) => {
    // The SDK invokes handlers as either `(input, extra)` (when an
    // `inputSchema` is declared) or `(extra)` (when it isn't). We can
    // distinguish by checking whether the last argument looks like the
    // request "extra" object.
    const hasInput = args.length > 1;
    const toolArgs = hasInput ? args[0] : undefined;

    const startedAt = Date.now();
    console.log(`[MCP] tool call: ${name}`);
    console.debug(`[MCP]   args: ${stringifyForLog(toolArgs)}`);

    try {
      const result = await handler(...args);
      const durationMs = Date.now() - startedAt;
      console.log(`[MCP] tool ok:   ${name} (${durationMs}ms)`);
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      console.error(
        `[MCP] tool err:  ${name} (${durationMs}ms):`,
        error,
      );
      throw error;
    }
  };
};

type LoadedTool = {
  name: string;
  filePath: string;
  module: ToolModule;
};

/**
 * Discover and load every tool module on disk. Runs once at module load
 * time (i.e. server boot) so the available tool catalogue is logged a
 * single time rather than on every new MCP session.
 */
const loadAllTools = (): LoadedTool[] => {
  // `__dirname` resolves to `src/mcp/tools` when running via ts-node and to
  // `dist/mcp/tools` after a tsc build. The extension of the currently
  // executing file tells us which source files to look for.
  const moduleExt = path.extname(__filename);
  const discovered = discoverToolFiles(__dirname, moduleExt).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const loaded: LoadedTool[] = [];

  console.log(
    `[MCP] discovering tools under ${__dirname} (${discovered.length} candidate(s))`,
  );

  for (const { name, filePath } of discovered) {
    const toolModule = loadToolModule(filePath);

    if (!toolModule) {
      console.warn(
        `[MCP] skipping ${filePath}: no \`tool\` (or default) export matching ToolModule`,
      );
      continue;
    }

    const title = toolModule.config.title ?? name;
    console.log(`[MCP]   • ${name}  (${title})  [${path.relative(__dirname, filePath)}]`);
    loaded.push({ name, filePath, module: toolModule });
  }

  console.log(`[MCP] tool discovery complete: ${loaded.length} tool(s) ready`);

  return loaded;
};

// Eagerly load and log the tool catalogue at boot time.
const TOOL_CATALOGUE: readonly LoadedTool[] = loadAllTools();

/**
 * Register every previously-discovered tool on the given MCP server
 * instance. This is invoked once per MCP session and stays silent — the
 * boot-time catalogue log above already enumerates what is available.
 */
export const registerTools = (server: McpServer): void => {
  for (const { name, module: toolModule } of TOOL_CATALOGUE) {
    server.registerTool(
      name,
      // The SDK's `registerTool` is generic over Zod schemas; tool modules
      // are loaded dynamically so we cast through `any` and trust the
      // module's declared `ToolConfig`/`ToolHandler` shape.
      toolModule.config as any,
      withInvocationLogging(name, toolModule.handler) as any,
    );
  }
};

