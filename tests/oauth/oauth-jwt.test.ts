import {
  generateRefreshToken,
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from "../../src/oauth/jwt";

describe("oauth jwt", () => {
  it("signs and verifies an access token with expected claims", () => {
    const { token, expiresIn } = signAccessToken({
      sub: "adam",
      github_id: 12345,
      client_id: "client-1",
      scope: "read",
    });

    expect(typeof token).toBe("string");
    expect(expiresIn).toBe(15 * 24 * 60 * 60);

    const payload = verifyAccessToken(token);
    expect(payload.sub).toBe("adam");
    expect(payload.github_id).toBe(12345);
    expect(payload.client_id).toBe("client-1");
    expect(payload.scope).toBe("read");
    expect(payload.iss).toBe("http://localhost:3000");
    expect(payload.aud).toBe("http://localhost:3000/mcp");
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  it("rejects an invalid token", () => {
    expect(() => verifyAccessToken("not-a-jwt")).toThrow();
  });
});

describe("refresh token helpers", () => {
  it("generates a high-entropy opaque token plus its sha256 hash", () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();

    expect(typeof a.token).toBe("string");
    // 48 random bytes => 64 base64url characters.
    expect(a.token.length).toBe(64);
    expect(a.token).not.toEqual(b.token);
    expect(a.hashed).not.toEqual(a.token);
    expect(a.hashed).toEqual(hashRefreshToken(a.token));
    expect(a.expiresAt).toBeGreaterThan(Date.now());
    expect(a.ttlSeconds).toBeGreaterThan(0);
  });

  it("hashes the same input to the same digest deterministically", () => {
    expect(hashRefreshToken("abc")).toEqual(hashRefreshToken("abc"));
    expect(hashRefreshToken("abc")).not.toEqual(hashRefreshToken("abd"));
  });
});
