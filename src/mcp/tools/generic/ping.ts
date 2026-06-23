import { ToolModule } from "../../../types/tool";

export const tool: ToolModule = {
  config: {
    title: "Ping",
    description:
      "Ping tool that responds with pong and a timestamp and can be used to check the server's responsiveness.",
    annotations: {
      readOnlyHint: true,
    },
  },
  handler: async () => {
    const timestamp = new Date().toISOString();

    const structuredContent = {
      pong: true,
      timestamp,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  },
};
