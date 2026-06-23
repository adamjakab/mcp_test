import {
  authCodeStore,
  clientStore,
  pendingRequestStore,
  refreshTokenStore,
  type IssuedRefreshToken,
  type PendingAuthRequest,
} from "../../src/oauth/store";

describe("oauth store", () => {
  it("saves and reads registered clients", () => {
    const clientId = `client-${Date.now()}`;

    clientStore.save({
      client_id: clientId,
      redirect_uris: ["http://localhost/callback"],
      created_at: Date.now(),
    });

    const saved = clientStore.get(clientId);
    expect(saved).toBeDefined();
    expect(saved?.client_id).toBe(clientId);
    expect(saved?.redirect_uris).toEqual(["http://localhost/callback"]);
  });

  it("takes pending requests only once", () => {
    const state = `state-${Date.now()}`;
    const req: PendingAuthRequest = {
      client_id: "client-1",
      redirect_uri: "http://localhost/callback",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      created_at: Date.now(),
    };

    pendingRequestStore.save(state, req);

    expect(pendingRequestStore.take(state)).toEqual(req);
    expect(pendingRequestStore.take(state)).toBeUndefined();
  });

  it("drops stale pending requests during sweep", () => {
    const staleState = `stale-${Date.now()}`;
    const freshState = `fresh-${Date.now()}`;
    const nowSpy = jest.spyOn(Date, "now");

    nowSpy.mockReturnValue(10_000_000);
    pendingRequestStore.save(staleState, {
      client_id: "client-stale",
      redirect_uri: "http://localhost/stale",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      created_at: 10_000_000 - 601_000,
    });

    nowSpy.mockReturnValue(10_000_100);
    pendingRequestStore.save(freshState, {
      client_id: "client-fresh",
      redirect_uri: "http://localhost/fresh",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      created_at: 10_000_100,
    });

    expect(pendingRequestStore.take(staleState)).toBeUndefined();
    expect(pendingRequestStore.take(freshState)).toBeDefined();

    nowSpy.mockRestore();
  });

  it("takes auth codes only once", () => {
    const code = `code-${Date.now()}`;
    const issued = {
      client_id: "client-1",
      redirect_uri: "http://localhost/callback",
      code_challenge: "challenge",
      code_challenge_method: "S256" as const,
      github_login: "adam",
      github_id: 12345,
      created_at: Date.now(),
    };

    authCodeStore.save(code, issued);

    expect(authCodeStore.take(code)).toEqual(issued);
    expect(authCodeStore.take(code)).toBeUndefined();
  });
});

describe("refresh token store", () => {
  const makeEntry = (
    overrides: Partial<IssuedRefreshToken> = {},
  ): IssuedRefreshToken => ({
    client_id: "client-1",
    scope: "mcp",
    github_login: "adam",
    github_id: 12345,
    created_at: Date.now(),
    expires_at: Date.now() + 60_000,
    ...overrides,
  });

  it("takes refresh tokens only once (rotation)", () => {
    const hashed = `hash-${Date.now()}-rotate`;
    const entry = makeEntry();

    refreshTokenStore.save(hashed, entry);

    expect(refreshTokenStore.take(hashed)).toEqual(entry);
    // Second use must fail: this is what makes rotation effective against
    // replay.
    expect(refreshTokenStore.take(hashed)).toBeUndefined();
  });

  it("returns undefined and drops expired refresh tokens on take", () => {
    const hashed = `hash-${Date.now()}-expired`;
    const entry = makeEntry({ expires_at: Date.now() - 1 });

    refreshTokenStore.save(hashed, entry);

    expect(refreshTokenStore.take(hashed)).toBeUndefined();
    // And a subsequent lookup confirms it was deleted.
    expect(refreshTokenStore.take(hashed)).toBeUndefined();
  });

  it("revokes refresh tokens explicitly", () => {
    const hashed = `hash-${Date.now()}-revoke`;
    refreshTokenStore.save(hashed, makeEntry());

    refreshTokenStore.revoke(hashed);

    expect(refreshTokenStore.take(hashed)).toBeUndefined();
  });

  it("sweeps expired refresh tokens when saving a new one", () => {
    const staleHash = `stale-${Date.now()}`;
    const freshHash = `fresh-${Date.now()}`;

    refreshTokenStore.save(
      staleHash,
      makeEntry({ expires_at: Date.now() - 10 }),
    );
    // Saving any new entry triggers the sweep, evicting the expired one.
    refreshTokenStore.save(freshHash, makeEntry());

    expect(refreshTokenStore.take(staleHash)).toBeUndefined();
    expect(refreshTokenStore.take(freshHash)).toBeDefined();
  });
});
