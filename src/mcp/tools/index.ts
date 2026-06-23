import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPingTool } from "./ping";
import { registerGreetWithHelobeloTool } from "./greet-with-helobelo";


export const registerTools = (server: McpServer): void => {
  registerPingTool(server);
  registerGreetWithHelobeloTool(server);
};