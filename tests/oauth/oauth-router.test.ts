import { AddressInfo } from "net";
import { createHash, randomBytes } from "crypto";
import express from "express";

import { oauthRouter } from "../../src/oauth/router";
import { authCodeStore, clientStore, refreshTokenStore } from "../../src/oauth/store";
import { verifyAccessToken, hashRefreshToken } from "../../src/oauth/jwt";

// Mock the GitHub module so tests never hit the real GitHub API.
jest.mock("../../src/oauth/github");
import * as githubModule from "../../src/oauth/github";

// Spin up the router on an ephemeral port so we can exercise the real
// /token endpoint, including the refresh_token grant flow, without adding
// any HTTP testing dependency.
const startServer = async (): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(oauthRouter());

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const addr = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return {
    baseUrl,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
};

// Seed an authorization code through the underlying store (the parts of the
// flow before /token — /authorize and the GitHub callback — talk to GitHub
// and aren't what these tests exercise).
const seedAuthCode = (params: {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  github_login: string;
  github_id: number;
  scope?: string;
  github_refresh_token?: string;
}): string => {
  const code = `code-${Math.random().toString(36).slice(2)}`;
  authCodeStore.save(code, {
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    code_challenge: params.code_challenge,
    code_challenge_method: "S256",
    scope: params.scope,
    github_login: params.github_login,
    github_id: params.github_id,
    created_at: Date.now(),
    github_refresh_token: params.github_refresh_token,
  });
  return code;
};

// PKCE: the verifier is opaque random data, and code_challenge =
// BASE64URL(SHA256(verifier)). We compute both here so the test can pass
// the verifier to /token and pre-seed the challenge on the auth code.
const makePkcePair = (): { verifier: string; challenge: string } => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256")
    .update(verifier)
    .digest("base64url");
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
  body: Record<string, string>,
): Promise<{ status: number; json: any }> => {
  const res = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json = await res.json();
  return { status: res.status, json };
};

describe("oauth /token", () => {
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ baseUrl, close } = await startServer());
  });

  afterAll(async () => {
    await close();
  });

  it("issues an access + refresh token from an authorization_code grant", async () => {
    const clientId = `client-${Date.now()}-issue`;
    const redirectUri = "http://localhost/callback";
    registerClient(clientId, redirectUri);

    const pkce = makePkcePair();
    const code = seedAuthCode({
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: pkce.challenge,
      github_login: "adam",
      github_id: 12345,
      scope: "mcp",
    });

    const { status, json } = await postForm(baseUrl, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: pkce.verifier,
    });

    expect(status).toBe(200);
    expect(json.token_type).toBe("Bearer");
    expect(json.expires_in).toBeGreaterThan(0);
    expect(typeof json.access_token).toBe("string");
    expect(typeof json.refresh_token).toBe("string");
    expect(json.refresh_token_expires_in).toBeGreaterThan(0);

    // The access token must be a usable, verifiable MCP JWT for that user.
    const payload = verifyAccessToken(json.access_token);
    expect(payload.github_id).toBe(12345);
    expect(payload.sub).toBe("adam");
  });

  it("exchanges a refresh token for a fresh access + refresh token", async () => {
    const clientId = `client-${Date.now()}-refresh`;
    const redirectUri = "http://localhost/callback";
    registerClient(clientId, redirectUri);

    const pkce = makePkcePair();
    const code = seedAuthCode({
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: pkce.challenge,
      github_login: "adam",
      github_id: 12345,
    });

    const first = await postForm(baseUrl, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: pkce.verifier,
    });
    expect(first.status).toBe(200);

    const refreshed = await postForm(baseUrl, {
      grant_type: "refresh_token",
      refresh_token: first.json.refresh_token,
      client_id: clientId,
    });

    expect(refreshed.status).toBe(200);
    expect(refreshed.json.token_type).toBe("Bearer");
    expect(typeof refreshed.json.access_token).toBe("string");
    expect(typeof refreshed.json.refresh_token).toBe("string");
    // Rotated: a new refresh token must be returned, not the same one.
    expect(refreshed.json.refresh_token).not.toEqual(first.json.refresh_token);

    // Identity carries through to the new access token.
    const payload = verifyAccessToken(refreshed.json.access_token);
    expect(payload.github_id).toBe(12345);
    expect(payload.sub).toBe("adam");
  });

  it("accepts refresh_token grant without client_id for public clients", async () => {
    const clientId = `client-${Date.now()}-refresh-no-client-id`;
    const redirectUri = "http://localhost/callback";
    registerClient(clientId, redirectUri);

    const pkce = makePkcePair();
    const code = seedAuthCode({
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: pkce.challenge,
      github_login: "adam",
      github_id: 12345,
    });

    const first = await postForm(baseUrl, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: pkce.verifier,
    });
    expect(first.status).toBe(200);

    const refreshed = await postForm(baseUrl, {
      grant_type: "refresh_token",
      refresh_token: first.json.refresh_token,
    });

    expect(refreshed.status).toBe(200);
    expect(refreshed.json.token_type).toBe("Bearer");
    expect(typeof refreshed.json.access_token).toBe("string");
    expect(typeof refreshed.json.refresh_token).toBe("string");
  });

  it("rotates the refresh token: replaying the old one fails", async () => {
    const clientId = `client-${Date.now()}-rotate`;
    const redirectUri = "http://localhost/callback";
    registerClient(clientId, redirectUri);

    const pkce = makePkcePair();
    const code = seedAuthCode({
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: pkce.challenge,
      github_login: "adam",
      github_id: 12345,
    });

    const first = await postForm(baseUrl, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: pkce.verifier,
    });
    expect(first.status).toBe(200);

    const ok = await postForm(baseUrl, {
      grant_type: "refresh_token",
      refresh_token: first.json.refresh_token,
      client_id: clientId,
    });
    expect(ok.status).toBe(200);

    // Same refresh token, second time, must be rejected.
    const replay = await postForm(baseUrl, {
      grant_type: "refresh_token",
      refresh_token: first.json.refresh_token,
      client_id: clientId,
    });
    expect(replay.status).toBe(400);
    expect(replay.json.error).toBe("invalid_grant");
  });

  it("rejects a refresh token presented by a different client", async () => {
    const issuerClient = `client-${Date.now()}-issuer`;
    const attackerClient = `client-${Date.now()}-attacker`;
    const redirectUri = "http://localhost/callback";
    registerClient(issuerClient, redirectUri);
    registerClient(attackerClient, redirectUri);

    const pkce = makePkcePair();
    const code = seedAuthCode({
      client_id: issuerClient,
      redirect_uri: redirectUri,
      code_challenge: pkce.challenge,
      github_login: "adam",
      github_id: 12345,
    });

    const first = await postForm(baseUrl, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: issuerClient,
      code_verifier: pkce.verifier,
    });
    expect(first.status).toBe(200);

    const stolen = await postForm(baseUrl, {
      grant_type: "refresh_token",
      refresh_token: first.json.refresh_token,
      client_id: attackerClient,
    });
    expect(stolen.status).toBe(400);
    expect(stolen.json.error).toBe("invalid_grant");

    // And the token is now revoked: the legitimate client also can't use it.
    const legit = await postForm(baseUrl, {
      grant_type: "refresh_token",
      refresh_token: first.json.refresh_token,
      client_id: issuerClient,
    });
    expect(legit.status).toBe(400);
    expect(legit.json.error).toBe("invalid_grant");
  });

  it("rejects refresh attempts from a user no longer on the allowlist", async () => {
    const clientId = `client-${Date.now()}-allowlist`;
    const redirectUri = "http://localhost/callback";
    registerClient(clientId, redirectUri);

    const pkce = makePkcePair();
    // 99999 is intentionally NOT in GITHUB_ALLOWED_USER_IDS (12345,67890).
    const code = seedAuthCode({
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: pkce.challenge,
      github_login: "stranger",
      github_id: 99999,
    });

    // The authorization_code grant itself does NOT re-check the allowlist
    // (the check happens at /oauth/callback). Seeding the auth code directly
    // lets us simulate a previously-issued refresh token whose owner has
    // since been removed from the allowlist.
    const first = await postForm(baseUrl, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: pkce.verifier,
    });
    expect(first.status).toBe(200);

    const refreshed = await postForm(baseUrl, {
      grant_type: "refresh_token",
      refresh_token: first.json.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(400);
    expect(refreshed.json.error).toBe("invalid_grant");
  });

  it("rejects unknown refresh tokens", async () => {
    const clientId = `client-${Date.now()}-unknown`;
    registerClient(clientId, "http://localhost/callback");

    const { status, json } = await postForm(baseUrl, {
      grant_type: "refresh_token",
      refresh_token: "never-issued-this-token",
      client_id: clientId,
    });

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_grant");
  });

  it("rejects refresh requests with missing parameters", async () => {
    const { status, json } = await postForm(baseUrl, {
      grant_type: "refresh_token",
    });

    expect(status).toBe(400);
    expect(json.error).toBe("invalid_request");
  });

  it("rejects unsupported grant types", async () => {
    const { status, json } = await postForm(baseUrl, {
      grant_type: "password",
      username: "x",
      password: "y",
    });

    expect(status).toBe(400);
    expect(json.error).toBe("unsupported_grant_type");
  });

  it("advertises both grant types in authorization-server metadata", async () => {
    const res = await fetch(
      `${baseUrl}/.well-known/oauth-authorization-server`,
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { grant_types_supported: string[] };
    expect(json.grant_types_supported).toEqual(
      expect.arrayContaining(["authorization_code", "refresh_token"]),
    );
  });
});

describe("oauth /token - GitHub refresh token integration", () => {
  let baseUrl: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ baseUrl, close } = await startServer());
  });

  afterAll(async () => {
    await close();
  });

  it("calls GitHub to refresh when a github_refresh_token is stored, and carries the new token forward", async () => {
    const clientId = `client-${Date.now()}-gh-refresh`;
    const redirectUri = "http://localhost/callback";
    registerClient(clientId, redirectUri);

    // Set up GitHub mock: token refresh returns a new access token and a
    // rotated GitHub refresh token; user lookup confirms the same identity.
    (githubModule.refreshGitHubToken as jest.Mock).mockResolvedValue({
      access_token: "gh-access-token-2",
      token_type: "bearer",
      scope: "read:user",
      refresh_token: "gh-refresh-token-2",
      expires_in: 3600,
    });
    (githubModule.fetchGitHubUser as jest.Mock).mockResolvedValue({
      id: 12345,
      login: "adam",
    });

    // Seed an auth code that carries a GitHub refresh token (simulating what
    // the /oauth/callback route does for GitHub Apps with expiring tokens).
    const pkce = makePkcePair();
    const code = seedAuthCode({
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: pkce.challenge,
      github_login: "adam",
      github_id: 12345,
      github_refresh_token: "gh-refresh-token-1",
    });

    const first = await postForm(baseUrl, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: pkce.verifier,
    });
    expect(first.status).toBe(200);

    // Refresh the MCP token; this must trigger a GitHub token refresh.
    const refreshed = await postForm(baseUrl, {
      grant_type: "refresh_token",
      refresh_token: first.json.refresh_token,
      client_id: clientId,
    });

    expect(refreshed.status).toBe(200);
    expect(typeof refreshed.json.access_token).toBe("string");
    expect(typeof refreshed.json.refresh_token).toBe("string");
    expect(refreshed.json.refresh_token).not.toEqual(first.json.refresh_token);

    // The GitHub refresh call must have been made with the original token.
    expect(githubModule.refreshGitHubToken).toHaveBeenCalledWith("gh-refresh-token-1");
    expect(githubModule.fetchGitHubUser).toHaveBeenCalledWith("gh-access-token-2");

    // Identity carries through correctly.
    const payload = verifyAccessToken(refreshed.json.access_token);
    expect(payload.github_id).toBe(12345);
    expect(payload.sub).toBe("adam");

    // The new MCP refresh token must carry the rotated GitHub refresh token,
    // so the next refresh will use the updated GitHub token.
    const newRefreshHashed = hashRefreshToken(refreshed.json.refresh_token);
    const stored = refreshTokenStore.take(newRefreshHashed);
    expect(stored?.github_refresh_token).toBe("gh-refresh-token-2");
  });

  it("rejects the refresh if the GitHub token refresh fails (session revoked)", async () => {
    const clientId = `client-${Date.now()}-gh-revoked`;
    const redirectUri = "http://localhost/callback";
    registerClient(clientId, redirectUri);

    // Simulate GitHub refusing the refresh (token revoked / app de-authorized).
    (githubModule.refreshGitHubToken as jest.Mock).mockRejectedValue(
      new Error("GitHub token refresh failed: {\"error\":\"bad_verification_code\"}"),
    );

    const pkce = makePkcePair();
    const code = seedAuthCode({
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: pkce.challenge,
      github_login: "adam",
      github_id: 12345,
      github_refresh_token: "gh-refresh-revoked",
    });

    const first = await postForm(baseUrl, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: pkce.verifier,
    });
    expect(first.status).toBe(200);

    const refreshed = await postForm(baseUrl, {
      grant_type: "refresh_token",
      refresh_token: first.json.refresh_token,
      client_id: clientId,
    });

    expect(refreshed.status).toBe(400);
    expect(refreshed.json.error).toBe("invalid_grant");
    expect(refreshed.json.error_description).toMatch(/GitHub session/i);
  });

  it("skips GitHub refresh when no github_refresh_token is stored (standard OAuth App)", async () => {
    const clientId = `client-${Date.now()}-no-gh-refresh`;
    const redirectUri = "http://localhost/callback";
    registerClient(clientId, redirectUri);

    const pkce = makePkcePair();
    const code = seedAuthCode({
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: pkce.challenge,
      github_login: "adam",
      github_id: 12345,
      // No github_refresh_token → standard OAuth App path.
    });

    const first = await postForm(baseUrl, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: pkce.verifier,
    });
    expect(first.status).toBe(200);

    const refreshed = await postForm(baseUrl, {
      grant_type: "refresh_token",
      refresh_token: first.json.refresh_token,
      client_id: clientId,
    });

    expect(refreshed.status).toBe(200);
    expect(typeof refreshed.json.access_token).toBe("string");

    // GitHub refresh should NOT have been called.
    expect(githubModule.refreshGitHubToken).not.toHaveBeenCalled();
  });
});
