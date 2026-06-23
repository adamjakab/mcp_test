import { mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    clientStore,
    githubTokenStore,
    loadPersistedStore,
    refreshTokenStore,
    _resetStorePathForTesting,
    type IssuedRefreshToken,
    type RegisteredClient,
    type StoredGitHubToken,
} from '../../src/oauth/store';

// Use a dedicated temp directory for each test run so parallel runs don't
// interfere with each other.
const TMP_DIR = join(tmpdir(), `mcp-store-test-${process.pid}`);
mkdirSync(TMP_DIR, { recursive: true });

const storePath = (name: string): string => join(TMP_DIR, `${name}.json`);

afterEach(() => {
    // Disable persistence so mutations in other test suites are not written to
    // files that don't exist.
    _resetStorePathForTesting();
});

afterAll(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
});

const makeClient = (id: string): RegisteredClient => ({
    client_id: id,
    redirect_uris: ['http://localhost/callback'],
    created_at: Date.now(),
});

const makeToken = (overrides: Partial<IssuedRefreshToken> = {}): IssuedRefreshToken => ({
    client_id: 'client-1',
    scope: 'mcp',
    github_login: 'adam',
    github_id: 12345,
    created_at: Date.now(),
    expires_at: Date.now() + 60_000,
    ...overrides,
});

const makeGitHubToken = (overrides: Partial<StoredGitHubToken> = {}): StoredGitHubToken => ({
    client_id: 'client-1',
    github_login: 'adam',
    github_id: 12345,
    access_token: 'gh-access-token-1',
    refresh_token: 'gh-refresh-token-1',
    expires_at: Date.now() + 60_000,
    updated_at: Date.now(),
    ...overrides,
});

describe('store persistence: clients', () => {
    it('persists a registered client to disk', () => {
        const path = storePath('clients-persist');
        loadPersistedStore(path);

        const client = makeClient('persist-client-1');
        clientStore.save(client);

        const raw = JSON.parse(readFileSync(path, 'utf8'));
        expect(raw.clients['persist-client-1']).toBeDefined();
        expect(raw.clients['persist-client-1'].redirect_uris).toEqual(['http://localhost/callback']);
    });

    it('reloads clients from disk after a simulated restart', () => {
        const path = storePath('clients-reload');
        loadPersistedStore(path);

        clientStore.save(makeClient('reload-client-1'));

        // Simulate restart: reset path and reload the same file.
        loadPersistedStore(path);
        const loaded = clientStore.get('reload-client-1');
        expect(loaded).toBeDefined();
        expect(loaded?.redirect_uris).toEqual(['http://localhost/callback']);
    });
});

describe('store persistence: refresh tokens', () => {
    it('persists a refresh token to disk', () => {
        const path = storePath('rt-persist');
        loadPersistedStore(path);

        const hashed = `hash-persist-${Date.now()}`;
        refreshTokenStore.save(hashed, makeToken());

        const raw = JSON.parse(readFileSync(path, 'utf8'));
        expect(raw.refreshTokens[hashed]).toBeDefined();
        expect(raw.refreshTokens[hashed].github_login).toBe('adam');
    });

    describe('store persistence: github tokens', () => {
        it('persists GitHub OAuth token state to disk', () => {
            const path = storePath('gh-persist');
            loadPersistedStore(path);

            githubTokenStore.save(makeGitHubToken());

            const raw = JSON.parse(readFileSync(path, 'utf8'));
            expect(raw.githubTokens['client-1']).toBeDefined();
            expect(raw.githubTokens['client-1'].access_token).toBe('gh-access-token-1');
            expect(raw.githubTokens['client-1'].refresh_token).toBe('gh-refresh-token-1');
            expect(typeof raw.githubTokens['client-1'].expires_at).toBe('number');
        });

        it('reloads GitHub OAuth token state after a simulated restart', () => {
            const path = storePath('gh-reload');
            loadPersistedStore(path);

            githubTokenStore.save(makeGitHubToken());
            loadPersistedStore(path);

            const loaded = githubTokenStore.get('client-1');
            expect(loaded).toBeDefined();
            expect(loaded?.access_token).toBe('gh-access-token-1');
            expect(loaded?.refresh_token).toBe('gh-refresh-token-1');
            expect(typeof loaded?.expires_at).toBe('number');
        });
    });

    it('reloads a valid refresh token after a simulated restart', () => {
        const path = storePath('rt-reload');
        loadPersistedStore(path);

        const hashed = `hash-reload-${Date.now()}`;
        refreshTokenStore.save(hashed, makeToken());

        // Simulate restart.
        loadPersistedStore(path);
        const loaded = refreshTokenStore.take(hashed);
        expect(loaded).toBeDefined();
        expect(loaded?.github_login).toBe('adam');
    });

    it('does not reload an expired refresh token after a simulated restart', () => {
        const path = storePath('rt-expired');
        loadPersistedStore(path);

        const hashed = `hash-expired-${Date.now()}`;
        // Save with an already-expired timestamp directly to the file to
        // simulate a token that expired while the server was down.
        refreshTokenStore.save(hashed, makeToken({ expires_at: Date.now() - 1 }));

        // Simulate restart (expired entry should be filtered out on load).
        loadPersistedStore(path);
        expect(refreshTokenStore.take(hashed)).toBeUndefined();
    });

    it('removes a revoked refresh token from the persisted file', () => {
        const path = storePath('rt-revoke');
        loadPersistedStore(path);

        const hashed = `hash-revoke-${Date.now()}`;
        refreshTokenStore.save(hashed, makeToken());
        refreshTokenStore.revoke(hashed);

        const raw = JSON.parse(readFileSync(path, 'utf8'));
        expect(raw.refreshTokens[hashed]).toBeUndefined();
    });

    it('removes a consumed (taken) refresh token from the persisted file', () => {
        const path = storePath('rt-take');
        loadPersistedStore(path);

        const hashed = `hash-take-${Date.now()}`;
        refreshTokenStore.save(hashed, makeToken());
        refreshTokenStore.take(hashed);

        const raw = JSON.parse(readFileSync(path, 'utf8'));
        expect(raw.refreshTokens[hashed]).toBeUndefined();
    });

    it('starts with empty stores when the file does not exist', () => {
        const path = storePath('rt-missing');
        // Do NOT create the file; loadPersistedStore should not throw.
        expect(() => loadPersistedStore(path)).not.toThrow();
    });
});
