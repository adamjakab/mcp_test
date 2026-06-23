// In-memory stores for OAuth state. Suitable for a single-process MCP server.
// For multi-instance deployments these should be replaced with a shared store
// (Redis, database, etc.).
//
// When STORE_PATH is configured the clients, refresh-token maps, and GitHub
// OAuth token state are persisted to a JSON file so that sessions survive
// server restarts.  The
// short-lived pending-request and auth-code maps are intentionally NOT
// persisted (both have a 10-minute TTL and are meaningless after a restart).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { STORE_PATH } from '../config/env';

export interface RegisteredClient {
    client_id: string;
    client_name?: string;
    redirect_uris: string[];
    created_at: number;
}

export interface PendingAuthRequest {
    // Original client (the MCP client, e.g. Claude) request parameters that we
    // must echo back when redirecting to its redirect_uri.
    client_id: string;
    redirect_uri: string;
    state?: string;
    scope?: string;
    code_challenge: string;
    code_challenge_method: 'S256';
    created_at: number;
}

export interface IssuedAuthCode {
    client_id: string;
    redirect_uri: string;
    code_challenge: string;
    code_challenge_method: 'S256';
    scope?: string;
    // Identity verified via GitHub.
    github_login: string;
    github_id: number;
    created_at: number;
    // GitHub refresh token received at callback time. Present only when the
    // GitHub App has expiring user tokens enabled.
    github_refresh_token?: string;
}

export interface IssuedRefreshToken {
    client_id: string;
    scope?: string;
    // Identity verified via GitHub when the originating authorization code was
    // exchanged. Refreshed tokens carry the same identity.
    github_login: string;
    github_id: number;
    created_at: number;
    // Absolute expiry timestamp in ms since epoch.
    expires_at: number;
    // GitHub refresh token carried through from the original authorization.
    // Used to re-validate the GitHub session on each MCP token renewal.
    // Present only when the GitHub App has expiring user tokens enabled.
    github_refresh_token?: string;
}

export interface StoredGitHubToken {
    client_id: string;
    github_login: string;
    github_id: number;
    access_token: string;
    refresh_token: string;
    expires_at: number;
    updated_at: number;
}

const clients = new Map<string, RegisteredClient>();
const pendingRequests = new Map<string, PendingAuthRequest>();
const authCodes = new Map<string, IssuedAuthCode>();
// Keyed by the sha256 hash of the opaque refresh token (so a memory dump or
// log leak doesn't reveal usable tokens). Each entry has its own absolute
// expiry, which we honour during sweep and on lookup.
const refreshTokens = new Map<string, IssuedRefreshToken>();
const githubTokens = new Map<string, StoredGitHubToken>();

// ---- Disk persistence -------------------------------------------------------

interface PersistedStoreData {
    clients: Record<string, RegisteredClient>;
    refreshTokens: Record<string, IssuedRefreshToken>;
    githubTokens: Record<string, StoredGitHubToken>;
}

// Mutable so tests can override without touching process.env.
let _storePath: string | undefined = STORE_PATH;

/**
 * Load persisted clients and refresh tokens from `path`.  Expired refresh
 * tokens are silently dropped.  A missing file is treated as an empty store;
 * any other read/parse error is logged as a warning.
 *
 * Exported so tests can call it with a temporary path without relying on the
 * module-level `STORE_PATH` value.
 */
export const loadPersistedStore = (path: string): void => {
    _storePath = path;
    try {
        const raw = readFileSync(path, 'utf8');
        const data = JSON.parse(raw) as PersistedStoreData;
        if (data.clients && typeof data.clients === 'object') {
            for (const [k, v] of Object.entries(data.clients)) {
                clients.set(k, v);
            }
        }
        if (data.refreshTokens && typeof data.refreshTokens === 'object') {
            const now = Date.now();
            for (const [k, v] of Object.entries(data.refreshTokens)) {
                // Skip tokens that already expired while the server was down.
                if (v.expires_at > now) {
                    refreshTokens.set(k, v);
                }
            }
        }
        if (data.githubTokens && typeof data.githubTokens === 'object') {
            for (const [k, v] of Object.entries(data.githubTokens)) {
                githubTokens.set(k, v);
            }
        }
        console.log(`[Store] Loaded persisted store from ${path}`);
    } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.warn(`[Store] Could not load persisted store from ${path}:`, err);
        }
    }
};

const persistToDisk = (): void => {
    if (!_storePath) return;
    try {
        const data: PersistedStoreData = {
            clients: Object.fromEntries(clients),
            refreshTokens: Object.fromEntries(refreshTokens),
            githubTokens: Object.fromEntries(githubTokens),
        };
        const tmp = `${_storePath}.tmp`;
        mkdirSync(dirname(_storePath), { recursive: true });
        writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
        renameSync(tmp, _storePath);
    } catch (err) {
        console.error(`[Store] Failed to persist store to ${_storePath}:`, err);
    }
};

// Auto-load on module initialisation when STORE_PATH is configured.
if (STORE_PATH) {
    loadPersistedStore(STORE_PATH);
}

/**
 * Reset the active store path to `undefined` (disables persistence).
 * Intended for use in tests only — not part of the production API.
 */
export const _resetStorePathForTesting = (): void => {
    _storePath = undefined;
};

// ---- Sweep helpers ----------------------------------------------------------

const TEN_MINUTES = 10 * 60 * 1000;

const sweep = <T extends { created_at: number }>(map: Map<string, T>, ttlMs: number) => {
    const now = Date.now();
    for (const [key, value] of map.entries()) {
        if (now - value.created_at > ttlMs) {
            map.delete(key);
        }
    }
};

export const clientStore = {
    save(client: RegisteredClient): void {
        clients.set(client.client_id, client);
        persistToDisk();
    },
    get(clientId: string): RegisteredClient | undefined {
        return clients.get(clientId);
    },
};

export const pendingRequestStore = {
    save(state: string, req: PendingAuthRequest): void {
        sweep(pendingRequests, TEN_MINUTES);
        pendingRequests.set(state, req);
    },
    take(state: string): PendingAuthRequest | undefined {
        const req = pendingRequests.get(state);
        if (req) pendingRequests.delete(state);
        return req;
    },
};

export const authCodeStore = {
    save(code: string, value: IssuedAuthCode): void {
        sweep(authCodes, TEN_MINUTES);
        authCodes.set(code, value);
    },
    take(code: string): IssuedAuthCode | undefined {
        const value = authCodes.get(code);
        if (value) authCodes.delete(code);
        return value;
    },
};

// Sweep entries whose absolute `expires_at` is in the past.
const sweepExpired = <T extends { expires_at: number }>(map: Map<string, T>) => {
    const now = Date.now();
    for (const [key, value] of map.entries()) {
        if (value.expires_at <= now) {
            map.delete(key);
        }
    }
};

export const refreshTokenStore = {
    save(hashedToken: string, value: IssuedRefreshToken): void {
        sweepExpired(refreshTokens);
        refreshTokens.set(hashedToken, value);
        persistToDisk();
    },
    // Consume (rotate): look up the token, delete it, and return it only if it
    // exists and has not expired. Returning `undefined` for either case lets
    // callers respond with a single `invalid_grant` error without leaking
    // whether the token was unknown or merely expired.
    take(hashedToken: string): IssuedRefreshToken | undefined {
        const value = refreshTokens.get(hashedToken);
        if (!value) return undefined;
        refreshTokens.delete(hashedToken);
        if (value.expires_at <= Date.now()) {
            persistToDisk();
            return undefined;
        }
        persistToDisk();
        return value;
    },
    revoke(hashedToken: string): void {
        refreshTokens.delete(hashedToken);
        persistToDisk();
    },
};

export const githubTokenStore = {
    save(value: StoredGitHubToken): void {
        githubTokens.set(value.client_id, value);
        persistToDisk();
    },
    get(clientId: string): StoredGitHubToken | undefined {
        return githubTokens.get(clientId);
    },
    delete(clientId: string): void {
        githubTokens.delete(clientId);
        persistToDisk();
    },
};
