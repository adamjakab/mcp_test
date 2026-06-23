import { ensureFreshGitHubToken } from '../../src/oauth/github-token';
import { githubTokenStore } from '../../src/oauth/store';

jest.mock('../../src/oauth/github');
import { refreshGitHubToken } from '../../src/oauth/github';

describe('ensureFreshGitHubToken', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    it('returns immediately without refreshing when the token is still valid', async () => {
        const clientId = `client-valid-${Date.now()}`;
        githubTokenStore.save({
            client_id: clientId,
            github_login: 'adam',
            github_id: 12345,
            access_token: 'access-valid',
            refresh_token: 'refresh-valid',
            expires_at: Date.now() + 5 * 60 * 1000,
            updated_at: Date.now(),
        });

        const result = await ensureFreshGitHubToken(clientId);

        expect(result).toBeDefined();
        expect(result!.access_token).toBe('access-valid');
        expect(refreshGitHubToken).not.toHaveBeenCalled();
    });

    it('refreshes and persists rotated GitHub tokens when expired', async () => {
        const clientId = `client-expired-${Date.now()}`;
        githubTokenStore.save({
            client_id: clientId,
            github_login: 'adam',
            github_id: 12345,
            access_token: 'access-old',
            refresh_token: 'refresh-old',
            expires_at: Date.now(),
            updated_at: Date.now(),
        });

        (refreshGitHubToken as jest.Mock).mockResolvedValue({
            access_token: 'access-new',
            refresh_token: 'refresh-new',
            token_type: 'bearer',
            scope: 'read:user',
            expires_in: 3600,
        });

        const result = await ensureFreshGitHubToken(clientId);
        expect(refreshGitHubToken).toHaveBeenCalledWith('refresh-old');
        expect(result).toBeDefined();
        expect(result!.access_token).toBe('access-new');
        expect(result!.refresh_token).toBe('refresh-new');

        const stored = githubTokenStore.get(clientId);
        expect(stored?.access_token).toBe('access-new');
        expect(stored?.refresh_token).toBe('refresh-new');
        expect((stored?.expires_at ?? 0) > Date.now()).toBe(true);
    });

    it('throws when GitHub refresh payload contains an error field', async () => {
        const clientId = `client-error-${Date.now()}`;
        githubTokenStore.save({
            client_id: clientId,
            github_login: 'adam',
            github_id: 12345,
            access_token: 'access-old',
            refresh_token: 'refresh-old',
            expires_at: Date.now(),
            updated_at: Date.now(),
        });

        (refreshGitHubToken as jest.Mock).mockResolvedValue({
            error: 'bad_verification_code',
            error_description: 'The refresh token is invalid',
        });

        await expect(ensureFreshGitHubToken(clientId)).rejects.toThrow(
            /bad_verification_code/i
        );
    });
});
