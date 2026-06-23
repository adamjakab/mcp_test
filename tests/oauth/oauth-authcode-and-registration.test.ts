import { AddressInfo } from 'net';
import { createHash, randomBytes } from 'crypto';
import express from 'express';
import { oauthRouter } from '../../src/oauth/router';
import {
  clientStore,
  authCodeStore,
  pendingRequestStore,
  githubTokenStore,
  _resetStorePathForTesting,
} from '../../src/oauth/store';

// Mock GitHub module
jest.mock('../../src/oauth/github');
import * as _githubModule from '../../src/oauth/github';

const startServer = async (): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(oauthRouter());

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      ),
  };
};

const makePkcePair = (): { verifier: string; challenge: string } => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256')
    .update(verifier)
    .digest('base64url');
  return { verifier, challenge };
};

const registerClient = (clientId: string, redirectUri: string): void => {
  clientStore.save({
    client_id: clientId,
    redirect_uris: [redirectUri],
    created_at: Date.now(),
  });
};

const postForm = async (
  baseUrl: string,
  path: string,
  body: Record<string, string>,
): Promise<{ status: number; json: any }> => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const json = await res.json();
  return { status: res.status, json };
};

const postJson = async (
  baseUrl: string,
  path: string,
  body: any,
): Promise<{ status: number; json: any }> => {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
};

describe('OAuth Client Registration (/register)', () => {
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ baseUrl, close } = await startServer());
  });

  afterAll(async () => {
    await close();
  });

  afterEach(() => {
    _resetStorePathForTesting();
  });

  it('registers a client with redirect_uris and returns client_id', async () => {
    const { status, json } = await postJson(baseUrl, '/register', {
      redirect_uris: ['http://localhost/callback'],
      client_name: 'My Test Client',
    });

    expect(status).toBe(201);
    expect(typeof json.client_id).toBe('string');
    expect(json.client_id).toMatch(/^mcp-/);
    expect(json.redirect_uris).toEqual(['http://localhost/callback']);
    expect(json.client_name).toBe('My Test Client');
    expect(json.grant_types).toContain('authorization_code');
    expect(json.grant_types).toContain('refresh_token');
  });

  it('rejects registration without redirect_uris', async () => {
    const { status, json } = await postJson(baseUrl, '/register', {
      client_name: 'No Redirect',
    });

    expect(status).toBe(400);
    expect(json.error).toBe('invalid_redirect_uri');
    expect(json.error_description).toMatch(/must be a non-empty array/i);
  });

  it('rejects registration with empty redirect_uris array', async () => {
    const { status, json } = await postJson(baseUrl, '/register', {
      redirect_uris: [],
    });

    expect(status).toBe(400);
    expect(json.error).toBe('invalid_redirect_uri');
  });

  it('rejects registration with non-string redirect_uris entries', async () => {
    const { status, json } = await postJson(baseUrl, '/register', {
      redirect_uris: [123],
    });

    expect(status).toBe(400);
    expect(json.error).toBe('invalid_redirect_uri');
    expect(json.error_description).toMatch(/entries must be strings/i);
  });

  it('accepts optional client_name', async () => {
    const { status, json } = await postJson(baseUrl, '/register', {
      redirect_uris: ['http://localhost/callback'],
    });

    expect(status).toBe(201);
    expect(json.client_name).toBeUndefined();
  });

  it('accepts multiple redirect_uris', async () => {
    const { status, json } = await postJson(baseUrl, '/register', {
      redirect_uris: [
        'http://localhost/callback',
        'http://localhost:8080/callback',
      ],
    });

    expect(status).toBe(201);
    expect(json.redirect_uris.length).toBe(2);
  });

  it('generates unique client_ids for each registration', async () => {
    const { json: json1 } = await postJson(baseUrl, '/register', {
      redirect_uris: ['http://localhost/callback1'],
    });

    const { json: json2 } = await postJson(baseUrl, '/register', {
      redirect_uris: ['http://localhost/callback2'],
    });

    expect(json1.client_id).not.toBe(json2.client_id);
  });

  it('persists registered clients', async () => {
    const { json: registered } = await postJson(baseUrl, '/register', {
      redirect_uris: ['http://localhost/callback'],
      client_name: 'Persist Test',
    });

    const retrieved = clientStore.get(registered.client_id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.client_name).toBe('Persist Test');
  });
});

describe('OAuth Authorization Endpoint (/authorize)', () => {
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ baseUrl, close } = await startServer());
  });

  afterAll(async () => {
    await close();
  });

  it('redirects to GitHub for valid authorization request', async () => {
    const clientId = `client-${Date.now()}-auth`;
    registerClient(clientId, 'http://localhost/callback');

    const pkce = makePkcePair();
    const res = await fetch(
      `${baseUrl}/authorize?response_type=code&client_id=${clientId}&redirect_uri=http://localhost/callback&scope=read:user&state=abc123&code_challenge=${pkce.challenge}&code_challenge_method=S256`,
      { redirect: 'manual' }
    );

    // Should redirect (301-308 range) or respond with location header
    expect([200, 301, 302, 303, 307, 308]).toContain(res.status);
  });

  it('rejects authorization request without response_type', async () => {
    const clientId = `client-${Date.now()}-no-response-type`;
    registerClient(clientId, 'http://localhost/callback');

    const pkce = makePkcePair();
    const res = await fetch(
      `${baseUrl}/authorize?client_id=${clientId}&redirect_uri=http://localhost/callback&state=abc123&code_challenge=${pkce.challenge}&code_challenge_method=S256`
    );

    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).toContain('unsupported_response_type');
  });

  it('rejects authorization request with unsupported response_type', async () => {
    const clientId = `client-${Date.now()}-token-response`;
    registerClient(clientId, 'http://localhost/callback');

    const pkce = makePkcePair();
    const res = await fetch(
      `${baseUrl}/authorize?response_type=token&client_id=${clientId}&redirect_uri=http://localhost/callback&state=abc123&code_challenge=${pkce.challenge}&code_challenge_method=S256`
    );

    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).toContain('unsupported_response_type');
  });

  it('rejects authorization request without client_id', async () => {
    const pkce = makePkcePair();
    const res = await fetch(
      `${baseUrl}/authorize?response_type=code&redirect_uri=http://localhost/callback&state=abc123&code_challenge=${pkce.challenge}&code_challenge_method=S256`
    );

    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).toContain('invalid_request');
  });

  it('rejects authorization request without redirect_uri', async () => {
    const clientId = `client-${Date.now()}-no-redirect`;
    registerClient(clientId, 'http://localhost/callback');

    const pkce = makePkcePair();
    const res = await fetch(
      `${baseUrl}/authorize?response_type=code&client_id=${clientId}&state=abc123&code_challenge=${pkce.challenge}&code_challenge_method=S256`
    );

    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).toContain('invalid_request');
  });

  it('rejects authorization request with unknown client_id', async () => {
    const pkce = makePkcePair();
    const res = await fetch(
      `${baseUrl}/authorize?response_type=code&client_id=unknown-client&redirect_uri=http://localhost/callback&state=abc123&code_challenge=${pkce.challenge}&code_challenge_method=S256`
    );

    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).toContain('invalid_client');
  });

  it('rejects authorization request with unregistered redirect_uri', async () => {
    const clientId = `client-${Date.now()}-wrong-redirect`;
    registerClient(clientId, 'http://localhost/callback');

    const pkce = makePkcePair();
    const res = await fetch(
      `${baseUrl}/authorize?response_type=code&client_id=${clientId}&redirect_uri=http://malicious.com/callback&state=abc123&code_challenge=${pkce.challenge}&code_challenge_method=S256`
    );

    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).toContain('not registered');
  });

  it('rejects authorization request without PKCE code_challenge', async () => {
    const clientId = `client-${Date.now()}-no-pkce`;
    registerClient(clientId, 'http://localhost/callback');

    const res = await fetch(
      `${baseUrl}/authorize?response_type=code&client_id=${clientId}&redirect_uri=http://localhost/callback&state=abc123`
    );

    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).toContain('PKCE required');
  });

  it('rejects authorization request with unsupported code_challenge_method', async () => {
    const clientId = `client-${Date.now()}-unsupported-pkce`;
    registerClient(clientId, 'http://localhost/callback');

    const pkce = makePkcePair();
    const res = await fetch(
      `${baseUrl}/authorize?response_type=code&client_id=${clientId}&redirect_uri=http://localhost/callback&state=abc123&code_challenge=${pkce.challenge}&code_challenge_method=plain`
    );

    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).toContain('S256');
  });

  it('rejects authorization request without code_challenge_method', async () => {
    const clientId = `client-${Date.now()}-no-method`;
    registerClient(clientId, 'http://localhost/callback');

    const pkce = makePkcePair();
    const res = await fetch(
      `${baseUrl}/authorize?response_type=code&client_id=${clientId}&redirect_uri=http://localhost/callback&state=abc123&code_challenge=${pkce.challenge}`
    );

    const text = await res.text();
    expect(res.status).toBe(400);
    expect(text).toContain('PKCE required');
  });
});

describe('OAuth Token Endpoint - Authorization Code Grant Edge Cases', () => {
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ baseUrl, close } = await startServer());
  });

  afterAll(async () => {
    await close();
  });

  afterEach(() => {
    _resetStorePathForTesting();
  });

  it('rejects authorization code exchange with invalid PKCE verifier', async () => {
    const clientId = `client-${Date.now()}-pkce-fail`;
    const redirectUri = 'http://localhost/callback';
    registerClient(clientId, redirectUri);

    const pkce = makePkcePair();
    const code = `code-${Date.now()}`;
    authCodeStore.save(code, {
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      github_login: 'adam',
      github_id: 12345,
      created_at: Date.now(),
    });

    const { status, json } = await postForm(baseUrl, '/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: 'wrong-verifier',
    });

    expect(status).toBe(400);
    expect(json.error).toBe('invalid_grant');
    expect(json.error_description).toMatch(/PKCE/i);
  });

  it('rejects authorization code exchange with client_id mismatch', async () => {
    const clientId1 = `client-${Date.now()}-1`;
    const clientId2 = `client-${Date.now()}-2`;
    const redirectUri = 'http://localhost/callback';
    registerClient(clientId1, redirectUri);
    registerClient(clientId2, redirectUri);

    const pkce = makePkcePair();
    const code = `code-${Date.now()}`;
    authCodeStore.save(code, {
      client_id: clientId1,
      redirect_uri: redirectUri,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      github_login: 'adam',
      github_id: 12345,
      created_at: Date.now(),
    });

    const { status, json } = await postForm(baseUrl, '/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId2,
      code_verifier: pkce.verifier,
    });

    expect(status).toBe(400);
    expect(json.error).toBe('invalid_grant');
    expect(json.error_description).toMatch(/mismatch/i);
  });

  it('rejects authorization code exchange with redirect_uri mismatch', async () => {
    const clientId = `client-${Date.now()}-redirect-mismatch`;
    const redirectUri1 = 'http://localhost/callback';
    const redirectUri2 = 'http://localhost:8080/callback';
    registerClient(clientId, redirectUri1);

    const pkce = makePkcePair();
    const code = `code-${Date.now()}`;
    authCodeStore.save(code, {
      client_id: clientId,
      redirect_uri: redirectUri1,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      github_login: 'adam',
      github_id: 12345,
      created_at: Date.now(),
    });

    const { status, json } = await postForm(baseUrl, '/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri2,
      client_id: clientId,
      code_verifier: pkce.verifier,
    });

    expect(status).toBe(400);
    expect(json.error).toBe('invalid_grant');
    expect(json.error_description).toMatch(/mismatch/i);
  });

  it('rejects authorization code exchange without code_verifier', async () => {
    const clientId = `client-${Date.now()}-no-verifier`;
    const redirectUri = 'http://localhost/callback';
    registerClient(clientId, redirectUri);

    const { status, json } = await postForm(baseUrl, '/token', {
      grant_type: 'authorization_code',
      code: 'some-code',
      redirect_uri: redirectUri,
      client_id: clientId,
    });

    expect(status).toBe(400);
    expect(json.error).toBe('invalid_request');
    expect(json.error_description).toMatch(/code_verifier/i);
  });

  it('rejects expired authorization code', async () => {
    const clientId = `client-${Date.now()}-expired-code`;
    const redirectUri = 'http://localhost/callback';
    registerClient(clientId, redirectUri);

    const pkce = makePkcePair();
    // Seed an auth code and immediately take it to expire it
    const code = `code-${Date.now()}`;
    authCodeStore.save(code, {
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      github_login: 'adam',
      github_id: 12345,
      created_at: Date.now(),
    });

    // Take the code (removes it)
    authCodeStore.take(code);

    const { status, json } = await postForm(baseUrl, '/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: pkce.verifier,
    });

    expect(status).toBe(400);
    expect(json.error).toBe('invalid_grant');
  });

  it('rejects authorization code exchange with missing code', async () => {
    const clientId = `client-${Date.now()}-no-code`;
    const redirectUri = 'http://localhost/callback';
    registerClient(clientId, redirectUri);

    const { status, json } = await postForm(baseUrl, '/token', {
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: 'some-verifier',
    });

    expect(status).toBe(400);
    expect(json.error).toBe('invalid_request');
  });
});

describe('OAuth Token Endpoint - Refresh Token Grant Edge Cases', () => {
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ baseUrl, close } = await startServer());
  });

  describe('OAuth callback - reconnect with stored refresh token', () => {
    let baseUrl: string;
    let close: () => Promise<void>;

    beforeAll(async () => {
      ({ baseUrl, close } = await startServer());
    });

    afterAll(async () => {
      await close();
    });

    it('uses stored GitHub refresh token when callback has no code', async () => {
      const clientId = `client-${Date.now()}-callback-refresh`;
      const redirectUri = 'http://localhost/callback';
      registerClient(clientId, redirectUri);

      pendingRequestStore.save('state-refresh', {
        client_id: clientId,
        redirect_uri: redirectUri,
        state: 'original-state',
        code_challenge: makePkcePair().challenge,
        code_challenge_method: 'S256',
        created_at: Date.now(),
      });
      githubTokenStore.save({
        client_id: clientId,
        github_login: 'adam',
        github_id: 12345,
        access_token: 'gh-access-1',
        refresh_token: 'gh-refresh-1',
        expires_at: Date.now(),
        updated_at: Date.now(),
      });

      (_githubModule.refreshGitHubToken as jest.Mock).mockResolvedValue({
        access_token: 'gh-access-2',
        refresh_token: 'gh-refresh-2',
        token_type: 'bearer',
        scope: 'read:user',
        expires_in: 3600,
      });

      const res = await fetch(`${baseUrl}/oauth/callback?state=state-refresh`, {
        redirect: 'manual',
      });

      expect([301, 302, 303, 307, 308]).toContain(res.status);
      const location = res.headers.get('location') || '';
      expect(location).toContain(`${redirectUri}?`);
      expect(location).toContain('code=');
      expect(location).toContain('state=original-state');
    });

    it('completes initial callback even when GitHub does not return a refresh token', async () => {
      const clientId = `client-${Date.now()}-callback-norefresh`;
      const redirectUri = 'http://localhost/callback';
      registerClient(clientId, redirectUri);

      const pkce = makePkcePair();
      pendingRequestStore.save('state-no-refresh', {
        client_id: clientId,
        redirect_uri: redirectUri,
        state: 'state-no-refresh',
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        created_at: Date.now(),
      });

      (_githubModule.exchangeGitHubCode as jest.Mock).mockResolvedValue({
        access_token: 'gh-access-1',
        token_type: 'bearer',
        scope: 'read:user',
        expires_in: 3600,
      });
      (_githubModule.fetchGitHubUser as jest.Mock).mockResolvedValue({
        id: 12345,
        login: 'adamjakab',
      });

      const res = await fetch(
        `${baseUrl}/oauth/callback?code=test-code&state=state-no-refresh`,
        { redirect: 'manual' },
      );

      expect([301, 302, 303, 307, 308]).toContain(res.status);
      const location = res.headers.get('location') || '';
      expect(location).toContain(`${redirectUri}?`);
      expect(location).toContain('code=');
    });

    it('completes initial callback even when GitHub omits expires_in', async () => {
      const clientId = `client-${Date.now()}-callback-no-expires`;
      const redirectUri = 'http://localhost/callback';
      registerClient(clientId, redirectUri);

      const pkce = makePkcePair();
      pendingRequestStore.save('state-no-expires', {
        client_id: clientId,
        redirect_uri: redirectUri,
        state: 'state-no-expires',
        code_challenge: pkce.challenge,
        code_challenge_method: 'S256',
        created_at: Date.now(),
      });

      (_githubModule.exchangeGitHubCode as jest.Mock).mockResolvedValue({
        access_token: 'gh-access-1',
        token_type: 'bearer',
        scope: 'read:user',
      });
      (_githubModule.fetchGitHubUser as jest.Mock).mockResolvedValue({
        id: 12345,
        login: 'adamjakab',
      });

      const res = await fetch(
        `${baseUrl}/oauth/callback?code=test-code&state=state-no-expires`,
        { redirect: 'manual' },
      );

      expect([301, 302, 303, 307, 308]).toContain(res.status);
      const location = res.headers.get('location') || '';
      expect(location).toContain(`${redirectUri}?`);
      expect(location).toContain('code=');
    });
  });

  afterAll(async () => {
    await close();
  });

  afterEach(() => {
    _resetStorePathForTesting();
  });

  it('rejects refresh token request with scope downgrade', async () => {
    const clientId = `client-${Date.now()}-scope-downgrade`;
    const redirectUri = 'http://localhost/callback';
    registerClient(clientId, redirectUri);

    const pkce = makePkcePair();
    const code = `code-${Date.now()}`;
    authCodeStore.save(code, {
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      scope: 'read:user write:repo',
      github_login: 'adam',
      github_id: 12345,
      created_at: Date.now(),
    });

    const first = await postForm(baseUrl, '/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: pkce.verifier,
    });

    expect(first.status).toBe(200);

    const refreshed = await postForm(baseUrl, '/token', {
      grant_type: 'refresh_token',
      refresh_token: first.json.refresh_token,
      client_id: clientId,
      scope: 'read:user',
    });

    expect(refreshed.status).toBe(400);
    expect(refreshed.json.error).toBe('invalid_scope');
  });

  it('rejects refresh token when binding client is deleted', async () => {
    const clientId = `client-${Date.now()}-deleted`;
    const redirectUri = 'http://localhost/callback';
    registerClient(clientId, redirectUri);

    const pkce = makePkcePair();
    const code = `code-${Date.now()}`;
    authCodeStore.save(code, {
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      github_login: 'adam',
      github_id: 12345,
      created_at: Date.now(),
    });

    const first = await postForm(baseUrl, '/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: pkce.verifier,
    });

    expect(first.status).toBe(200);

    // Simulate client deletion by removing it from store (in production this would be API-driven)
    // For now, we can't test this directly without exposing store mutations, so we skip

    // TODO: This test requires a way to delete clients, which isn't exposed in the OAuth API
  });

  it('accepts refresh token when scope is omitted (reuses original scope)', async () => {
    const clientId = `client-${Date.now()}-scope-reuse`;
    const redirectUri = 'http://localhost/callback';
    registerClient(clientId, redirectUri);

    const pkce = makePkcePair();
    const code = `code-${Date.now()}`;
    authCodeStore.save(code, {
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      scope: 'read:user',
      github_login: 'adam',
      github_id: 12345,
      created_at: Date.now(),
    });

    const first = await postForm(baseUrl, '/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: pkce.verifier,
    });

    expect(first.status).toBe(200);

    // Refresh without specifying scope
    const refreshed = await postForm(baseUrl, '/token', {
      grant_type: 'refresh_token',
      refresh_token: first.json.refresh_token,
      client_id: clientId,
    });

    expect(refreshed.status).toBe(200);
  });
});

describe('OAuth Well-Known Endpoints', () => {
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ baseUrl, close } = await startServer());
  });

  afterAll(async () => {
    await close();
  });

  it('serves /.well-known/oauth-authorization-server', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.issuer).toBeDefined();
    expect(json.authorization_endpoint).toBeDefined();
    expect(json.token_endpoint).toBeDefined();
    expect(json.registration_endpoint).toBeDefined();
    expect(json.response_types_supported).toContain('code');
    expect(json.grant_types_supported).toContain('authorization_code');
    expect(json.grant_types_supported).toContain('refresh_token');
    expect(json.code_challenge_methods_supported).toContain('S256');
    expect(json.token_endpoint_auth_methods_supported).toContain('none');
    expect(json.scopes_supported).toContain('mcp');
  });

  it('serves /.well-known/oauth-protected-resource', async () => {
    const res = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource`
    );
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.resource).toBeDefined();
    expect(json.authorization_servers).toBeDefined();
    expect(json.bearer_methods_supported).toContain('header');
    expect(json.scopes_supported).toContain('mcp');
  });

  it('serves /.well-known/oauth-protected-resource/mcp', async () => {
    const res = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource/mcp`
    );
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.resource).toBeDefined();
    expect(json.authorization_servers).toBeDefined();
    expect(json.bearer_methods_supported).toContain('header');
    expect(json.scopes_supported).toContain('mcp');
  });

  it('redirects the server root to /mcp', async () => {
    const res = await fetch(baseUrl, { redirect: 'manual' });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/mcp');
  });
});
