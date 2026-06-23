import { randomUUID } from "crypto";
import { Application, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerTools } from "./tools";
import packageJson from "../../package.json";
import {
  SESSION_IDLE_TTL_HOURS,
  SESSION_IDLE_TTL_MS,
} from "../config/env";

const createMcpServer = (): McpServer => {
  const server = new McpServer(
    {
      name: packageJson.name ?? "adam-mcp",
      version: packageJson.version ?? "0.0.0",
      title: packageJson.displayName ?? packageJson.name ?? "ADAM-MCP",
      description:
        packageJson.description ?? "MCP server for Adam assistant",
    },
    {
      instructions:
        "Use this server to access Adam's tools, data and personal information.",
    },
  );

  // Register built-in tools.
  registerTools(server);

  return server;
};

type SessionState = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastActivityAt: number;
};

const sessions: Record<string, SessionState> = {};
const SESSION_SWEEP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
let sessionSweepTimer: NodeJS.Timeout | null = null;

const getSessionId = (req: Request): string | undefined => {
  const headerValue = req.headers["mcp-session-id"];
  if (Array.isArray(headerValue)) {
    return headerValue[0];
  }

  return headerValue;
};

const stringifyForLog = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
};

const getToolCallDetails = (
  body: unknown,
): { toolName: string; toolArgs: unknown } | undefined => {
  if (!body || typeof body !== "object") {
    return undefined;
  }

  const request = body as { method?: unknown; params?: unknown };
  if (request.method !== "tools/call") {
    return undefined;
  }

  if (!request.params || typeof request.params !== "object") {
    return undefined;
  }

  const params = request.params as { name?: unknown; arguments?: unknown };
  if (typeof params.name !== "string") {
    return undefined;
  }

  return {
    toolName: params.name,
    toolArgs: params.arguments,
  };
};

const sweepIdleSessions = async (): Promise<void> => {
  const now = Date.now();

  for (const [sessionId, session] of Object.entries(sessions)) {
    const idleMs = now - session.lastActivityAt;
    if (idleMs < SESSION_IDLE_TTL_MS) {
      continue;
    }

    console.warn(
      `[MCP] session idle timeout: ${sessionId} (${Math.floor(idleMs / 1000)}s idle), closing session`,
    );

    try {
      await session.server.close();
    } catch (error) {
      console.error(`[MCP] failed to close idle session ${sessionId}:`, error);
      delete sessions[sessionId];
    }
  }
};

export const initializeServer = async (app: Application): Promise<void> => {
  if (!sessionSweepTimer) {
    sessionSweepTimer = setInterval(() => {
      void sweepIdleSessions();
    }, SESSION_SWEEP_INTERVAL_MS);

    sessionSweepTimer.unref();
    console.log(
      `[MCP] idle session cleanup enabled (timeout: ${SESSION_IDLE_TTL_HOURS} hours)`,
    );
  }

  app.all("/mcp", async (req: Request, res: Response) => {
    try {
      const sessionId = getSessionId(req);

      if (sessionId && sessions[sessionId]) {
        sessions[sessionId].lastActivityAt = Date.now();
        const toolCallDetails = getToolCallDetails(req.body);

        console.log(
          `[MCP] request for active session: ${sessionId}`,
        );

        if (toolCallDetails) {
          console.log(
            `[MCP] << [${toolCallDetails.toolName}]:`);
          console.debug(
            `[MCP] << ${stringifyForLog(toolCallDetails.toolArgs)}`,
          );
        }

        // Hande request
        await sessions[sessionId].transport.handleRequest(req, res, req.body);
        if (toolCallDetails) {
          console.debug(`[MCP] > response sent.`);
        }

        return;
      }

      if (
        !sessionId &&
        req.method === "POST" &&
        isInitializeRequest(req.body)
      ) {
        console.log("[MCP] initialize request received; creating new session");
        const server = createMcpServer();

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions[newSessionId] = {
              server,
              transport,
              lastActivityAt: Date.now(),
            };
            console.log(`[MCP] session connected: ${newSessionId}`);
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport.sessionId;
          if (closedSessionId && sessions[closedSessionId]) {
            console.log(`[MCP] session disconnected: ${closedSessionId}`);
            delete sessions[closedSessionId];
          } else {
            console.log(
              "[MCP] transport closed before session id was registered",
            );
          }
        };

        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // Per MCP Streamable HTTP spec: an unknown but provided session id
      // must return 404 so the client knows to discard it and reinitialize.
      // A missing session id on a non-initialize request is a 400.
      if (sessionId) {
        console.warn(
          `[MCP] unknown session ${sessionId} on ${req.method}; responding 404 so the client reinitializes`,
        );
        res.status(404).json({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Session not found",
          },
          id: null,
        });
        return;
      }

      console.warn(
        `[MCP] rejected request ${req.method} (sessionId=none): no valid MCP session`,
      );
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid MCP session ID provided",
        },
        id: null,
      });
    } catch (error) {
      console.error("MCP transport request failed:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal MCP server error" });
      }
    }
  });

  // Simple http endpoint for health checks. Not part of the MCP protocol, just a convenience.
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });
};
