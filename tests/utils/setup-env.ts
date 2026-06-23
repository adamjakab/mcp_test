import { tmpdir } from "os";
import { join } from "path";

process.env.PORT = process.env.PORT || "3000";
process.env.PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "http://localhost:3000";
process.env.GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID || "test-client-id";
process.env.GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "test-client-secret";
process.env.GITHUB_REDIRECT_URI =
  process.env.GITHUB_REDIRECT_URI || "http://localhost:3000/oauth/callback";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.ACCESS_TOKEN_TTL_HOURS = process.env.ACCESS_TOKEN_TTL_HOURS || "360";
process.env.SESSION_IDLE_TTL_HOURS = process.env.SESSION_IDLE_TTL_HOURS || "1";
process.env.ALLOWED_GITHUB_USER_IDS = process.env.ALLOWED_GITHUB_USER_IDS || "12345,67890";

// Always isolate OAuth persistence during tests to avoid touching live data files.
process.env.STORE_PATH = join(
  tmpdir(),
  `adam-mcp-jest-store-${process.pid}-${process.env.JEST_WORKER_ID || "0"}.json`,
);
