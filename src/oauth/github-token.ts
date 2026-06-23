import { refreshGitHubToken } from './github';
import { githubTokenStore, StoredGitHubToken } from './store';

const REFRESH_SAFETY_BUFFER_MS = 60 * 1000;

const formatError = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

export const ensureFreshGitHubToken = async (
    clientId: string,
    options?: { forceRefresh?: boolean }
): Promise<StoredGitHubToken | undefined> => {
    const stored = githubTokenStore.get(clientId);
    if (!stored) {
        return undefined;
    }

    const now = Date.now();
    const shouldRefresh =
        options?.forceRefresh === true ||
        stored.expires_at <= now + REFRESH_SAFETY_BUFFER_MS;
    if (!shouldRefresh) {
        return stored;
    }
    if (!stored.refresh_token) {
        return stored;
    }

    let refreshed;
    try {
        refreshed = await refreshGitHubToken(stored.refresh_token);
    } catch (error) {
        throw new Error(`Failed to refresh GitHub access token: ${formatError(error)}`);
    }

    const responseWithError = refreshed as {
        error?: string;
        error_description?: string;
    };
    if (typeof responseWithError.error === 'string' && responseWithError.error.length > 0) {
        throw new Error(
            `GitHub token refresh failed: ${responseWithError.error}${responseWithError.error_description ? ` (${responseWithError.error_description})` : ''}`
        );
    }

    if (!refreshed.access_token) {
        throw new Error('GitHub token refresh response did not include access_token');
    }
    if (!refreshed.refresh_token) {
        throw new Error('GitHub token refresh response did not include refresh_token');
    }
    if (typeof refreshed.expires_in !== 'number' || refreshed.expires_in <= 0) {
        throw new Error('GitHub token refresh response did not include a valid expires_in');
    }

    const updated: StoredGitHubToken = {
        ...stored,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        expires_at: now + refreshed.expires_in * 1000,
        updated_at: now,
    };
    githubTokenStore.save(updated);
    return updated;
};
