import { Request, Response, NextFunction } from 'express';
import { PUBLIC_BASE_URL, isUserAllowed } from '../config/env';
import { verifyAccessToken, McpAccessTokenPayload } from './jwt';
import { ensureFreshGitHubToken } from './github-token';

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            user?: McpAccessTokenPayload;
        }
    }
}

const RESOURCE_METADATA_URL = `${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource`;

const sendUnauthorized = (
    res: Response,
    error: string,
    description: string,
    status = 401
): void => {
    // RFC 9728 / MCP authorization spec: point clients at our resource metadata.
    const challenge = `Bearer realm="mcp", error="${error}", error_description="${description}", resource_metadata="${RESOURCE_METADATA_URL}"`;
    res.setHeader('WWW-Authenticate', challenge);
    res.status(status).json({
        error,
        error_description: description,
    });
};

const sendMcpError = (req: Request, res: Response, message: string, status = 401): void => {
    const id =
        req.body &&
        typeof req.body === 'object' &&
        'id' in (req.body as Record<string, unknown>)
            ? (req.body as { id?: unknown }).id ?? null
            : null;
    res.status(status).json({
        jsonrpc: '2.0',
        error: {
            code: -32002,
            message,
            data: {
                action: 'Re-authenticate via Settings -> Connectors.',
            },
        },
        id,
    });
};

export const bearerAuth = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    const header = req.headers['authorization'];
    if (!header || typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) {
        sendUnauthorized(res, 'invalid_token', 'Missing or malformed Bearer token');
        return;
    }

    const token = header.slice('Bearer '.length).trim();
    if (!token) {
        sendUnauthorized(res, 'invalid_token', 'Empty Bearer token');
        return;
    }

    let payload: McpAccessTokenPayload;
    try {
        payload = verifyAccessToken(token);
    } catch (err) {
        const message = err instanceof Error ? err.message : 'token verification failed';
        sendUnauthorized(res, 'invalid_token', message);
        return;
    }

    // Defense-in-depth: re-check the allowlist on every request, in case the
    // list changed since the token was issued. Match by numeric GitHub id.
    if (!isUserAllowed(payload.github_id)) {
        console.warn(
            `[Auth] DENIED bearer: GitHub id ${payload.github_id} ("${payload.sub}") is NOT in the allowlist`
        );
        sendUnauthorized(
            res,
            'insufficient_scope',
            `GitHub user id ${payload.github_id} ("${payload.sub}") is not authorized`,
            403
        );
        return;
    }

    try {
        await ensureFreshGitHubToken(payload.client_id);
    } catch (error) {
        const reason = error instanceof Error ? error.message : 'GitHub token refresh failed';
        console.warn(
            `[Auth] GitHub token refresh failed for client ${payload.client_id}: ${reason}`
        );
        sendMcpError(
            req,
            res,
            'GitHub session refresh failed. Re-authenticate via Settings -> Connectors.'
        );
        return;
    }

    console.log(
        `[Auth] OK: bearer accepted for GitHub id ${payload.github_id} ("${payload.sub}") ${req.method} ${req.originalUrl}`
    );

    req.user = payload;
    next();
};
