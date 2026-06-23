import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

export const registerGreetWithHelobeloTool = (server: McpServer): void => {
  server.registerTool(
    "greet-with-helobelo",
    {
      description: "Greet someone by name if they say ``helobelo``.",
      inputSchema: z.object({ name: z.string() }),
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ name }) => ({
      content: [{ type: "text", text: `Helóbeló ${name}! Hogy vagy?` }],
    }),
  );
};
