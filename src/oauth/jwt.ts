import jwt, { SignOptions } from 'jsonwebtoken';
import { createHash, randomBytes } from 'crypto';
import {
    JWT_SECRET,
    ACCESS_TOKEN_TTL_SECONDS,
    PUBLIC_BASE_URL,
    REFRESH_TOKEN_TTL_SECONDS,
} from '../config/env';

export interface McpAccessTokenClaims {
    sub: string; // GitHub login
    github_id: number;
    scope?: string;
    client_id: string;
}

export interface McpAccessTokenPayload extends McpAccessTokenClaims {
    iss: string;
    aud: string;
    iat: number;
    exp: number;
}

const ISSUER = PUBLIC_BASE_URL;
const AUDIENCE = `${PUBLIC_BASE_URL}/mcp`;

export const signAccessToken = (claims: McpAccessTokenClaims): { token: string; expiresIn: number } => {
    const options: SignOptions = {
        algorithm: 'HS256',
        issuer: ISSUER,
        audience: AUDIENCE,
        expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    };
    const token = jwt.sign(claims, JWT_SECRET, options);
    return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
};

export const verifyAccessToken = (token: string): McpAccessTokenPayload => {
    return jwt.verify(token, JWT_SECRET, {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
    }) as McpAccessTokenPayload;
};

// Refresh tokens are opaque high-entropy strings, not JWTs, so the server can
// revoke or rotate them. We hand the raw token to the client but only ever
// store its sha256 hash so a memory dump or log leak can't be replayed.
export const hashRefreshToken = (token: string): string =>
    createHash('sha256').update(token).digest('hex');

export const generateRefreshToken = (): {
    token: string;
    hashed: string;
    expiresAt: number;
    ttlSeconds: number;
} => {
    const token = randomBytes(48).toString('base64url');
    return {
        token,
        hashed: hashRefreshToken(token),
        expiresAt: Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000,
        ttlSeconds: REFRESH_TOKEN_TTL_SECONDS,
    };
};
