import { config } from "dotenv";
import { isAbsolute, resolve } from "path";

type OpenApiToolSource = {
  url: string;
  namePrefix?: string;
  headerEnvVars?: Record<string, string>;
};

config();

// Project root - two levels up from this file. Works for both the TS source
// location (src/config/env.ts) and the compiled output (dist/config/env.js).
const PROJECT_ROOT = resolve(__dirname, "..", "..");

const requireEnv = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

export const PORT = Number(process.env.PORT || 3334);

// Publicly reachable base URL of this MCP server (no trailing slash).
// Example: https://adam-mcp.adibadi.net
export const PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`
).replace(/\/$/, "");

// GitHub OAuth App credentials.
// Accept both GITHUB_* and the legacy CLIENT_* names already used in .env.
export const GITHUB_CLIENT_ID = requireEnv("GITHUB_CLIENT_ID");
export const GITHUB_CLIENT_SECRET = requireEnv("GITHUB_CLIENT_SECRET");

// Secret used to sign MCP access tokens (JWT). MUST be set in production.
export const JWT_SECRET = requireEnv("JWT_SECRET");

// Callback URL registered in the GitHub OAuth App settings.
// This is where GitHub redirects after the user authorizes the app.
export const GITHUB_REDIRECT_URI = `${PUBLIC_BASE_URL}/oauth/callback`;

// Access-token lifetime - default: 15 days.
export const ACCESS_TOKEN_TTL_HOURS = Number(
  requireEnv("ACCESS_TOKEN_TTL_HOURS", "360"),
);
export const ACCESS_TOKEN_TTL_SECONDS = ACCESS_TOKEN_TTL_HOURS * 60 * 60;

// Refresh-token lifetime - default: 15 days. 
// Should be longer than access-token TTL to allow session renewal without re-login.
// Refresh tokens are opaque, server-stored,
// and rotated on every use, so this can safely be longer than the access-token TTL.
export const REFRESH_TOKEN_TTL_HOURS = Number(
  requireEnv("REFRESH_TOKEN_TTL_HOURS", "360"),

);
export const REFRESH_TOKEN_TTL_SECONDS = REFRESH_TOKEN_TTL_HOURS * 60 * 60;

// Idle MCP session cleanup threshold - default: 15 days. 
// Sessions with no activity for this duration will be removed.
export const SESSION_IDLE_TTL_HOURS = Number(
  requireEnv("SESSION_IDLE_TTL_HOURS", "360"),
);
export const SESSION_IDLE_TTL_MS = SESSION_IDLE_TTL_HOURS * 60 * 60 * 1000;

// Hardcoded allowlist of GitHub numeric user IDs permitted to use this MCP
// server. The list is sourced from the GITHUB_ALLOWED_USER_IDS env var
// (comma-separated numeric IDs). GitHub IDs are stable and immutable, unlike
// logins which a user can rename.
export const GITHUB_ALLOWED_USER_IDS: number[] = (
  process.env.GITHUB_ALLOWED_USER_IDS || ""
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const n = Number(s);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(
        `Invalid entry in GITHUB_ALLOWED_USER_IDS: "${s}" is not a positive integer`,
      );
    }
    return n;
  });

export const isUserAllowed = (githubId: number | undefined | null): boolean => {
  if (githubId === undefined || githubId === null) return false;
  return GITHUB_ALLOWED_USER_IDS.includes(githubId);
};

// Dynamic OpenAPI tool sources. Configured via the OPENAPI_TOOL_SOURCES env
// var, which must be a JSON array of objects matching `OpenApiToolSource`.
// Example:
//   OPENAPI_TOOL_SOURCES=[{
//     "url":"https://mygarminapi.adibadi.net/openapi.json",
//     "namePrefix":"garmin_",
//     "headerEnvVars":{"x-api-key":"GARMIN_API_KEY"}
//   }]
//
// Returns an empty array if the env var is unset or contains the empty string.
// Throws on invalid JSON or wrong shape so misconfiguration fails fast.
const parseOpenApiToolSources = (): OpenApiToolSource[] => {
  const raw = process.env.OPENAPI_TOOL_SOURCES;
  if (!raw || raw.trim() === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `OPENAPI_TOOL_SOURCES is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error("OPENAPI_TOOL_SOURCES must be a JSON array");
  }

  const sources: OpenApiToolSource[] = [];
  parsed.forEach((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`OPENAPI_TOOL_SOURCES[${index}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.url !== "string" || e.url.trim() === "") {
      throw new Error(
        `OPENAPI_TOOL_SOURCES[${index}].url must be a non-empty string`,
      );
    }
    sources.push(e as unknown as OpenApiToolSource);
  });

  return sources;
};

export const OPENAPI_TOOL_SOURCES: OpenApiToolSource[] =
  parseOpenApiToolSources();

const parseBooleanEnv = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
};

// Mailbox settings for IMAP/SMTP tools. These are optional at startup and
// validated when a mailbox tool is invoked.
export const MAILBOX_IMAP_HOST = process.env.MAILBOX_IMAP_HOST || "";
export const MAILBOX_IMAP_PORT = Number(process.env.MAILBOX_IMAP_PORT || "993");
export const MAILBOX_IMAP_TLS = parseBooleanEnv(process.env.MAILBOX_IMAP_TLS, true);
export const MAILBOX_IMAP_USER = process.env.MAILBOX_IMAP_USER || "";
export const MAILBOX_IMAP_PASSWORD = process.env.MAILBOX_IMAP_PASSWORD || "";
export const MAILBOX_IMAP_DEFAULT_BOX = process.env.MAILBOX_IMAP_DEFAULT_BOX || "INBOX";

export const MAILBOX_SMTP_HOST = process.env.MAILBOX_SMTP_HOST || "";
export const MAILBOX_SMTP_PORT = Number(process.env.MAILBOX_SMTP_PORT || "587");
export const MAILBOX_SMTP_SECURE = parseBooleanEnv(
  process.env.MAILBOX_SMTP_SECURE,
  false,
);
export const MAILBOX_SMTP_USER = process.env.MAILBOX_SMTP_USER || "";
export const MAILBOX_SMTP_PASSWORD = process.env.MAILBOX_SMTP_PASSWORD || "";
export const MAILBOX_FROM_NAME = process.env.MAILBOX_FROM_NAME || "";

// Path to a JSON file used to persist OAuth state (registered clients and
// refresh tokens) across server restarts.  When unset, all state is kept
// in memory only and is lost on restart.  Set this to a writable file path
// (e.g. /data/oauth-store.json) to enable persistence.
//
// Relative paths (e.g. "./data/store.json") are resolved against the project
// root so the location is stable regardless of the process's cwd.  Absolute
// paths are used as-is.
export const STORE_PATH: string | undefined = (() => {
    const raw = process.env.STORE_PATH;
    if (!raw || raw === "") return undefined;
    return isAbsolute(raw) ? raw : resolve(PROJECT_ROOT, raw);
})();
