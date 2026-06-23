import { Router, Request, Response } from 'express';
import { createHash, randomBytes } from 'crypto';
import { PUBLIC_BASE_URL } from '../config/env';
import { isUserAllowed } from '../config/env';
import {
    buildGitHubAuthorizeUrl,
    exchangeGitHubCode,
    fetchGitHubUser,
    refreshGitHubToken,
} from './github';
import {
    authCodeStore,
    clientStore,
    githubTokenStore,
    pendingRequestStore,
    refreshTokenStore,
    RegisteredClient,
} from './store';
import { generateRefreshToken, hashRefreshToken, signAccessToken } from './jwt';
import { ensureFreshGitHubToken } from './github-token';

const newId = (bytes = 32): string => randomBytes(bytes).toString('hex');

const sha256base64url = (input: string): string =>
    createHash('sha256').update(input).digest('base64url');

const RESOURCE_URL = `${PUBLIC_BASE_URL}/mcp`;

const appendQuery = (base: string, params: Record<string, string | undefined>): string => {
    const url = new URL(base);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) url.searchParams.set(k, v);
    }
    return url.toString();
};

export const oauthRouter = (): Router => {
    const router = Router();

    // Some MCP clients probe the server root before following OAuth metadata.
    // Redirect them to the actual MCP transport endpoint.
    router.get('/', (_req: Request, res: Response) => {
        res.redirect(302, '/mcp');
    });

    // ---- RFC 9728: Protected Resource Metadata ---------------------------
    router.get('/.well-known/oauth-protected-resource', (_req: Request, res: Response) => {
        res.json({
            resource: RESOURCE_URL,
            authorization_servers: [PUBLIC_BASE_URL],
            bearer_methods_supported: ['header'],
            scopes_supported: ['mcp'],
        });
    });

    // The MCP spec also allows scoping the metadata document to a specific
    // resource path. Serve the same payload at /mcp's well-known path too.
    router.get('/.well-known/oauth-protected-resource/mcp', (_req: Request, res: Response) => {
        res.json({
            resource: RESOURCE_URL,
            authorization_servers: [PUBLIC_BASE_URL],
            bearer_methods_supported: ['header'],
            scopes_supported: ['mcp'],
        });
    });

    // ---- RFC 8414: Authorization Server Metadata -------------------------
    router.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
        res.json({
            issuer: PUBLIC_BASE_URL,
            authorization_endpoint: `${PUBLIC_BASE_URL}/authorize`,
            token_endpoint: `${PUBLIC_BASE_URL}/token`,
            registration_endpoint: `${PUBLIC_BASE_URL}/register`,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
            scopes_supported: ['mcp'],
        });
    });

    // ---- RFC 7591: Dynamic Client Registration ---------------------------
    router.post('/register', (req: Request, res: Response) => {
        const body = req.body ?? {};
        const redirectUris: unknown = body.redirect_uris;

        if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
            res.status(400).json({
                error: 'invalid_redirect_uri',
                error_description: 'redirect_uris must be a non-empty array',
            });
            return;
        }

        for (const uri of redirectUris) {
            if (typeof uri !== 'string') {
                res.status(400).json({
                    error: 'invalid_redirect_uri',
                    error_description: 'redirect_uris entries must be strings',
                });
                return;
            }
        }

        const client: RegisteredClient = {
            client_id: `mcp-${newId(16)}`,
            client_name: typeof body.client_name === 'string' ? body.client_name : undefined,
            redirect_uris: redirectUris as string[],
            created_at: Date.now(),
        };
        clientStore.save(client);

        console.log(
            `[OAuth] registered client ${client.client_id} (name=${client.client_name ?? 'n/a'})`
        );

        res.status(201).json({
            client_id: client.client_id,
            client_id_issued_at: Math.floor(client.created_at / 1000),
            redirect_uris: client.redirect_uris,
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
            client_name: client.client_name,
        });
    });

    // ---- Authorization endpoint ------------------------------------------
    router.get('/authorize', (req: Request, res: Response) => {
        const {
            response_type,
            client_id,
            redirect_uri,
            state,
            scope,
            code_challenge,
            code_challenge_method,
        } = req.query as Record<string, string | undefined>;

        if (response_type !== 'code') {
            res.status(400).send('unsupported_response_type: only "code" is supported');
            return;
        }
        if (!client_id || !redirect_uri) {
            res.status(400).send('invalid_request: client_id and redirect_uri are required');
            return;
        }
        if (!code_challenge || code_challenge_method !== 'S256') {
            res.status(400).send(
                'invalid_request: PKCE required (code_challenge with code_challenge_method=S256)'
            );
            return;
        }

        const client = clientStore.get(client_id);
        if (!client) {
            res.status(400).send('invalid_client: unknown client_id');
            return;
        }
        if (!client.redirect_uris.includes(redirect_uri)) {
            res.status(400).send('invalid_request: redirect_uri not registered for this client');
            return;
        }

        const proxyState = newId(16);
        pendingRequestStore.save(proxyState, {
            client_id,
            redirect_uri,
            state,
            scope,
            code_challenge,
            code_challenge_method: 'S256',
            created_at: Date.now(),
        });

        const githubUrl = buildGitHubAuthorizeUrl(proxyState);
        console.log(
            `[OAuth] /authorize client=${client_id} -> redirecting to GitHub (state=${proxyState})`
        );
        res.redirect(githubUrl);
    });

    // ---- GitHub callback -------------------------------------------------
    router.get('/oauth/callback', async (req: Request, res: Response) => {
        const code = typeof req.query.code === 'string' ? req.query.code : undefined;
        const state = typeof req.query.state === 'string' ? req.query.state : undefined;
        const ghError = typeof req.query.error === 'string' ? req.query.error : undefined;

        if (!state) {
            res.status(400).send('invalid_request: missing state');
            return;
        }
        const pending = pendingRequestStore.take(state);
        if (!pending) {
            res.status(400).send('invalid_request: unknown or expired state');
            return;
        }

        if (ghError) {
            const target = appendQuery(pending.redirect_uri, {
                error: ghError,
                state: pending.state,
            });
            res.redirect(target);
            return;
        }
        if (!code) {
            try {
                const refreshed = await ensureFreshGitHubToken(pending.client_id, {
                    forceRefresh: true,
                });
                if (!refreshed) {
                    const target = appendQuery(pending.redirect_uri, {
                        error: 'server_error',
                        error_description:
                            'No stored GitHub session was found. Re-authenticate via Settings -> Connectors.',
                        state: pending.state,
                    });
                    res.redirect(target);
                    return;
                }
                if (!isUserAllowed(refreshed.github_id)) {
                    const target = appendQuery(pending.redirect_uri, {
                        error: 'access_denied',
                        error_description: `GitHub user id ${refreshed.github_id} ("${refreshed.github_login}") is not authorized to use this MCP server`,
                        state: pending.state,
                    });
                    res.redirect(target);
                    return;
                }

                const authCode = newId(32);
                authCodeStore.save(authCode, {
                    client_id: pending.client_id,
                    redirect_uri: pending.redirect_uri,
                    code_challenge: pending.code_challenge,
                    code_challenge_method: pending.code_challenge_method,
                    scope: pending.scope,
                    github_login: refreshed.github_login,
                    github_id: refreshed.github_id,
                    created_at: Date.now(),
                    github_refresh_token: refreshed.refresh_token,
                });

                const target = appendQuery(pending.redirect_uri, {
                    code: authCode,
                    state: pending.state,
                });
                res.redirect(target);
                return;
            } catch (err) {
                const target = appendQuery(pending.redirect_uri, {
                    error: 'server_error',
                    error_description:
                        'Could not refresh stored GitHub session. Re-authenticate via Settings -> Connectors.',
                    state: pending.state,
                });
                res.redirect(target);
                return;
            }
        }

        try {
            const tokenResp = await exchangeGitHubCode(code);
            const user = await fetchGitHubUser(tokenResp.access_token);

            console.log(
                `[OAuth] GitHub identity resolved: login="${user.login}" id=${user.id}`
            );

            if (!isUserAllowed(user.id)) {
                console.warn(
                    `[OAuth] DENIED: GitHub id ${user.id} ("${user.login}") is NOT in the allowlist`
                );
                const target = appendQuery(pending.redirect_uri, {
                    error: 'access_denied',
                    error_description: `GitHub user id ${user.id} ("${user.login}") is not authorized to use this MCP server`,
                    state: pending.state,
                });
                res.redirect(target);
                return;
            }

            console.log(
                `[OAuth] ALLOWED: GitHub id ${user.id} ("${user.login}") matched the allowlist`
            );

            persistGitHubTokenForClient({
                client_id: pending.client_id,
                github_login: user.login,
                github_id: user.id,
                access_token: tokenResp.access_token,
                refresh_token: tokenResp.refresh_token,
                expires_in: tokenResp.expires_in,
            });

            const authCode = newId(32);
            authCodeStore.save(authCode, {
                client_id: pending.client_id,
                redirect_uri: pending.redirect_uri,
                code_challenge: pending.code_challenge,
                code_challenge_method: pending.code_challenge_method,
                scope: pending.scope,
                github_login: user.login,
                github_id: user.id,
                created_at: Date.now(),
                github_refresh_token: tokenResp.refresh_token,
            });

            console.log(
                `[OAuth] issued auth code for GitHub id ${user.id} ("${user.login}") (client=${pending.client_id})`
            );

            const target = appendQuery(pending.redirect_uri, {
                code: authCode,
                state: pending.state,
            });
            res.redirect(target);
        } catch (err) {
            console.error('[OAuth] GitHub callback failed:', err);
            const target = appendQuery(pending.redirect_uri, {
                error: 'server_error',
                error_description: 'Failed to complete GitHub authentication',
                state: pending.state,
            });
            res.redirect(target);
        }
    });

    // ---- Token endpoint --------------------------------------------------
    router.post('/token', async (req: Request, res: Response) => {
        const body = (req.body ?? {}) as Record<string, string | undefined>;
        const { grant_type, client_id } = body;

        if (grant_type === 'authorization_code') {
            handleAuthorizationCodeGrant(body, res);
            return;
        }
        if (grant_type === 'refresh_token') {
            await handleRefreshTokenGrant(body, res);
            return;
        }

        // Unsupported / missing grant_type. Don't leak which clients exist.
        void client_id;
        res.status(400).json({
            error: 'unsupported_grant_type',
            error_description:
                'Only authorization_code and refresh_token are supported',
        });
    });

    return router;
};

const issueTokenPair = (params: {
    github_login: string;
    github_id: number;
    scope?: string;
    client_id: string;
    github_refresh_token?: string;
}): {
    access_token: string;
    expires_in: number;
    refresh_token: string;
    refresh_token_expires_in: number;
    scope: string;
} => {
    const { token, expiresIn } = signAccessToken({
        sub: params.github_login,
        github_id: params.github_id,
        scope: params.scope,
        client_id: params.client_id,
    });

    const refresh = generateRefreshToken();
    refreshTokenStore.save(refresh.hashed, {
        client_id: params.client_id,
        scope: params.scope,
        github_login: params.github_login,
        github_id: params.github_id,
        created_at: Date.now(),
        expires_at: refresh.expiresAt,
        github_refresh_token: params.github_refresh_token,
    });

    return {
        access_token: token,
        expires_in: expiresIn,
        refresh_token: refresh.token,
        refresh_token_expires_in: refresh.ttlSeconds,
        scope: params.scope ?? 'mcp',
    };
};

const handleAuthorizationCodeGrant = (
    body: Record<string, string | undefined>,
    res: Response
): void => {
    const { code, redirect_uri, client_id, code_verifier } = body;

    if (!code || !redirect_uri || !client_id || !code_verifier) {
        res.status(400).json({
            error: 'invalid_request',
            error_description:
                'code, redirect_uri, client_id and code_verifier are required',
        });
        return;
    }

    const issued = authCodeStore.take(code);
    if (!issued) {
        res.status(400).json({
            error: 'invalid_grant',
            error_description: 'Authorization code is invalid or expired',
        });
        return;
    }
    if (issued.client_id !== client_id || issued.redirect_uri !== redirect_uri) {
        res.status(400).json({
            error: 'invalid_grant',
            error_description: 'client_id / redirect_uri mismatch for this code',
        });
        return;
    }

    const expected = sha256base64url(code_verifier);
    if (expected !== issued.code_challenge) {
        res.status(400).json({
            error: 'invalid_grant',
            error_description: 'PKCE verification failed',
        });
        return;
    }

    const tokens = issueTokenPair({
        github_login: issued.github_login,
        github_id: issued.github_id,
        scope: issued.scope,
        client_id: issued.client_id,
        github_refresh_token: issued.github_refresh_token,
    });

    console.log(
        `[OAuth] /token: issued access+refresh token for GitHub id ${issued.github_id} ("${issued.github_login}") (client=${issued.client_id})`
    );

    res.json({
        access_token: tokens.access_token,
        token_type: 'Bearer',
        expires_in: tokens.expires_in,
        refresh_token: tokens.refresh_token,
        refresh_token_expires_in: tokens.refresh_token_expires_in,
        scope: tokens.scope,
    });
};

const handleRefreshTokenGrant = async (
    body: Record<string, string | undefined>,
    res: Response
): Promise<void> => {
    const { refresh_token, client_id: presentedClientId, scope } = body;

    console.log(
        `[OAuth] /token: refresh_token request received (client=${presentedClientId ?? 'omitted'} scope=${scope ?? 'omitted'})`
    );

    if (!refresh_token) {
        res.status(400).json({
            error: 'invalid_request',
            error_description: 'refresh_token is required',
        });
        return;
    }

    // Consume (rotate). `take` deletes the token, so even a replay races
    // against itself: only the first caller sees a value, and an attacker
    // replaying the same refresh token immediately after will get
    // `invalid_grant`.
    const hashed = hashRefreshToken(refresh_token);
    const existing = refreshTokenStore.take(hashed);
    if (!existing) {
        res.status(400).json({
            error: 'invalid_grant',
            error_description: 'Refresh token is invalid or expired',
        });
        return;
    }

    // Some public clients omit client_id on refresh when no token endpoint
    // authentication is used. In that case, bind to the id persisted with
    // the refresh token itself.
    const effectiveClientId = presentedClientId ?? existing.client_id;

    if (presentedClientId && existing.client_id !== presentedClientId) {
        // The token was issued to a different client. Don't reissue it: the
        // safest action is to drop it (already done by `take`) and refuse.
        console.warn(
            `[OAuth] refresh_token client mismatch (issued=${existing.client_id} presented=${presentedClientId}); token revoked`
        );
        res.status(400).json({
            error: 'invalid_grant',
            error_description: 'Refresh token was not issued to this client',
        });
        return;
    }

    // Verify the bound client still exists.
    const client = clientStore.get(effectiveClientId);
    if (!client) {
        res.status(400).json({
            error: 'invalid_client',
            error_description: 'unknown client_id',
        });
        return;
    }

    // RFC 6749 §6: a scope on refresh must be a subset of the original. We
    // don't model fine-grained scopes here, so simply refuse downgrades to a
    // different scope string. If the client omits scope, reuse the original.
    if (scope !== undefined && scope !== existing.scope) {
        res.status(400).json({
            error: 'invalid_scope',
            error_description:
                'Refresh tokens cannot request a different scope than originally granted',
        });
        return;
    }

    // Re-check the allowlist by GitHub id: revoking a user from the env var
    // must take effect on the next refresh, not only when the JWT eventually
    // expires.
    if (!isUserAllowed(existing.github_id)) {
        console.warn(
            `[OAuth] DENIED refresh: GitHub id ${existing.github_id} ("${existing.github_login}") is no longer in the allowlist; token revoked`
        );
        res.status(400).json({
            error: 'invalid_grant',
            error_description: 'User is no longer authorized to use this server',
        });
        return;
    }

    // If the original authorization produced a GitHub refresh token (i.e. the
    // GitHub App has expiring user tokens enabled), use it to renew the GitHub
    // session now. This ensures the MCP session is immediately invalidated if
    // the user revokes the GitHub authorization or the GitHub token expires.
    let updatedGitHubRefreshToken = existing.github_refresh_token;
    if (existing.github_refresh_token) {
        try {
            const ghTokens = await refreshGitHubToken(existing.github_refresh_token);
            const user = await fetchGitHubUser(ghTokens.access_token);

            // Guard against an unexpected identity swap (defence in depth).
            if (user.id !== existing.github_id) {
                console.warn(
                    `[OAuth] DENIED refresh: GitHub identity mismatch (expected id=${existing.github_id}, got id=${user.id})`
                );
                res.status(400).json({
                    error: 'invalid_grant',
                    error_description: 'GitHub identity mismatch during token refresh',
                });
                return;
            }

            updatedGitHubRefreshToken = ghTokens.refresh_token;
            persistGitHubTokenForClient({
                client_id: existing.client_id,
                github_login: user.login,
                github_id: user.id,
                access_token: ghTokens.access_token,
                refresh_token: ghTokens.refresh_token,
                expires_in: ghTokens.expires_in,
            });
            console.log(
                `[OAuth] GitHub token refreshed for GitHub id ${user.id} ("${user.login}")`
            );
        } catch (err) {
            console.warn('[OAuth] GitHub token refresh failed:', err);
            res.status(400).json({
                error: 'invalid_grant',
                error_description: 'GitHub session has expired or been revoked',
            });
            return;
        }
    }

    const tokens = issueTokenPair({
        github_login: existing.github_login,
        github_id: existing.github_id,
        scope: existing.scope,
        client_id: existing.client_id,
        github_refresh_token: updatedGitHubRefreshToken,
    });

    console.log(
        `[OAuth] /token: refreshed access+refresh token for GitHub id ${existing.github_id} ("${existing.github_login}") (client=${existing.client_id})`
    );

    res.json({
        access_token: tokens.access_token,
        token_type: 'Bearer',
        expires_in: tokens.expires_in,
        refresh_token: tokens.refresh_token,
        refresh_token_expires_in: tokens.refresh_token_expires_in,
        scope: tokens.scope,
    });
};

const persistGitHubTokenForClient = (params: {
    client_id: string;
    github_login: string;
    github_id: number;
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
}): void => {
    if (!params.refresh_token) {
        console.warn(
            `[OAuth] GitHub OAuth response for client ${params.client_id} did not include a refresh_token; skipping GitHub token persistence`
        );
        return;
    }
    if (typeof params.expires_in !== 'number' || params.expires_in <= 0) {
        console.warn(
            `[OAuth] GitHub OAuth response for client ${params.client_id} did not include a valid expires_in; skipping GitHub token persistence`
        );
        return;
    }

    const now = Date.now();
    githubTokenStore.save({
        client_id: params.client_id,
        github_login: params.github_login,
        github_id: params.github_id,
        access_token: params.access_token,
        refresh_token: params.refresh_token,
        expires_at: now + params.expires_in * 1000,
        updated_at: now,
    });
};
