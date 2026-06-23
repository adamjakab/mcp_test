import axios from 'axios';
import { GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_REDIRECT_URI } from '../config/env';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';

// Minimal scope: read the authenticated user's profile so we can check the login
// against our allowlist. Adjust here if more GitHub data is needed later.
const GITHUB_SCOPE = 'read:user';

export interface GitHubTokenResponse {
    access_token: string;
    token_type: string;
    scope: string;
    // Present only when the GitHub App has expiring user tokens enabled.
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
}

interface GitHubTokenErrorResponse {
    error: string;
    error_description?: string;
    error_uri?: string;
}

export interface GitHubUser {
    id: number;
    login: string;
    name?: string;
    email?: string | null;
}

export const buildGitHubAuthorizeUrl = (state: string): string => {
    const params = new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        redirect_uri: GITHUB_REDIRECT_URI,
        scope: GITHUB_SCOPE,
        state,
        allow_signup: 'false',
    });
    return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
};

export const exchangeGitHubCode = async (code: string): Promise<GitHubTokenResponse> => {
    const response = await axios.post(
        GITHUB_TOKEN_URL,
        {
            client_id: GITHUB_CLIENT_ID,
            client_secret: GITHUB_CLIENT_SECRET,
            code,
            redirect_uri: GITHUB_REDIRECT_URI,
        },
        {
            headers: { Accept: 'application/json' },
        }
    );

    const maybeError = response.data as GitHubTokenErrorResponse | undefined;
    if (maybeError?.error) {
        throw new Error(
            `GitHub token exchange failed: ${maybeError.error}${maybeError.error_description ? ` (${maybeError.error_description})` : ''}`
        );
    }

    if (!response.data || !response.data.access_token) {
        throw new Error(
            `GitHub token exchange failed: ${JSON.stringify(response.data ?? {})}`
        );
    }

    return response.data as GitHubTokenResponse;
};

export const refreshGitHubToken = async (refreshToken: string): Promise<GitHubTokenResponse> => {
    const response = await axios.post(
        GITHUB_TOKEN_URL,
        {
            client_id: GITHUB_CLIENT_ID,
            client_secret: GITHUB_CLIENT_SECRET,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
        },
        {
            headers: { Accept: 'application/json' },
        }
    );

    const maybeError = response.data as GitHubTokenErrorResponse | undefined;
    if (maybeError?.error) {
        throw new Error(
            `GitHub token refresh failed: ${maybeError.error}${maybeError.error_description ? ` (${maybeError.error_description})` : ''}`
        );
    }

    if (!response.data || !response.data.access_token) {
        throw new Error(
            `GitHub token refresh failed: ${JSON.stringify(response.data ?? {})}`
        );
    }

    return response.data as GitHubTokenResponse;
};

export const fetchGitHubUser = async (accessToken: string): Promise<GitHubUser> => {
    const response = await axios.get(GITHUB_USER_URL, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'adam-mcp',
        },
    });

    return response.data as GitHubUser;
};
