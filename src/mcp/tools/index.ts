import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPingTool } from "./generic/ping";


export const registerTools = (server: McpServer): void => {
  registerPingTool(server);
};