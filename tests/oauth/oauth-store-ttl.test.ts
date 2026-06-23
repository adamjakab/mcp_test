import { authCodeStore, pendingRequestStore, refreshTokenStore } from '../../src/oauth/store';
import type { PendingAuthRequest } from '../../src/oauth/store';

describe('Store TTL and Sweep Behavior', () => {
  const TEN_MINUTES_MS = 10 * 60 * 1000;
  const _mockNow = (): number => Date.now();

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Pending Request Store - TTL Sweep', () => {
    it('sweeps pending requests older than 10 minutes', () => {
      const nowSpy = jest.spyOn(Date, 'now');
      const baseTime = 1000000;

      // Save a stale request
      nowSpy.mockReturnValue(baseTime);
      const staleState = `stale-${Date.now()}`;
      pendingRequestStore.save(staleState, {
        client_id: 'client-stale',
        redirect_uri: 'http://localhost/stale',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        state: 'state-1',
        scope: 'read',
        created_at: baseTime - TEN_MINUTES_MS - 1000,
      });

      // Advance time to after TTL expires
      nowSpy.mockReturnValue(baseTime + 1000);

      // Save a fresh request (triggers sweep)
      const freshState = `fresh-${Date.now()}`;
      pendingRequestStore.save(freshState, {
        client_id: 'client-fresh',
        redirect_uri: 'http://localhost/fresh',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        created_at: baseTime + 1000,
      });

      // Stale request should be gone, fresh should remain
      expect(pendingRequestStore.take(staleState)).toBeUndefined();
      expect(pendingRequestStore.take(freshState)).toBeDefined();

      nowSpy.mockRestore();
    });

    it('keeps pending requests younger than 10 minutes', () => {
      const nowSpy = jest.spyOn(Date, 'now');
      const baseTime = 1000000;

      nowSpy.mockReturnValue(baseTime);
      const recentState = `recent-${Date.now()}`;
      pendingRequestStore.save(recentState, {
        client_id: 'client-recent',
        redirect_uri: 'http://localhost/recent',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        created_at: baseTime - 1000,
      });

      // Advance time but stay within 10-minute TTL
      nowSpy.mockReturnValue(baseTime + 5 * 60 * 1000);

      const anotherState = `another-${Date.now()}`;
      pendingRequestStore.save(anotherState, {
        client_id: 'client-another',
        redirect_uri: 'http://localhost/another',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        created_at: baseTime + 5 * 60 * 1000,
      });

      expect(pendingRequestStore.take(recentState)).toBeDefined();

      nowSpy.mockRestore();
    });

    it('only allows taking a pending request once', () => {
      const state = `once-${Date.now()}`;
      const req: PendingAuthRequest = {
        client_id: 'client-1',
        redirect_uri: 'http://localhost/callback',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        created_at: Date.now(),
      };

      pendingRequestStore.save(state, req);

      const first = pendingRequestStore.take(state);
      expect(first).toEqual(req);

      const second = pendingRequestStore.take(state);
      expect(second).toBeUndefined();
    });
  });

  describe('Auth Code Store - TTL Sweep', () => {
    it('sweeps auth codes older than 10 minutes', () => {
      const nowSpy = jest.spyOn(Date, 'now');
      const baseTime = 2000000;

      nowSpy.mockReturnValue(baseTime);
      const staleCode = `stale-${Date.now()}`;
      authCodeStore.save(staleCode, {
        client_id: 'client-stale',
        redirect_uri: 'http://localhost/stale',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        github_login: 'adam',
        github_id: 12345,
        created_at: baseTime - TEN_MINUTES_MS - 1000,
      });

      nowSpy.mockReturnValue(baseTime + 1000);

      const freshCode = `fresh-${Date.now()}`;
      authCodeStore.save(freshCode, {
        client_id: 'client-fresh',
        redirect_uri: 'http://localhost/fresh',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        github_login: 'adam',
        github_id: 12345,
        created_at: baseTime + 1000,
      });

      expect(authCodeStore.take(staleCode)).toBeUndefined();
      expect(authCodeStore.take(freshCode)).toBeDefined();

      nowSpy.mockRestore();
    });

    it('only allows taking an auth code once', () => {
      const code = `code-${Date.now()}`;

      authCodeStore.save(code, {
        client_id: 'client-1',
        redirect_uri: 'http://localhost/callback',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
        github_login: 'adam',
        github_id: 12345,
        created_at: Date.now(),
      });

      const first = authCodeStore.take(code);
      expect(first).toBeDefined();

      const second = authCodeStore.take(code);
      expect(second).toBeUndefined();
    });
  });

  describe('Refresh Token Store - Absolute Expiry', () => {
    it('sweeps expired refresh tokens when taking', () => {
      const nowSpy = jest.spyOn(Date, 'now');
      const baseTime = 3000000;

      nowSpy.mockReturnValue(baseTime);

      const expiredHash = 'expired-token-hash';
      refreshTokenStore.save(expiredHash, {
        client_id: 'client-expired',
        scope: 'mcp',
        github_login: 'adam',
        github_id: 12345,
        created_at: baseTime - 10000,
        expires_at: baseTime - 1000,
      });

      // Try to take the expired token
      const result = refreshTokenStore.take(expiredHash);
      expect(result).toBeUndefined();

      nowSpy.mockRestore();
    });

    it('returns valid refresh tokens that have not expired', () => {
      const nowSpy = jest.spyOn(Date, 'now');
      const baseTime = 3000000;

      nowSpy.mockReturnValue(baseTime);

      const validHash = 'valid-token-hash';
      refreshTokenStore.save(validHash, {
        client_id: 'client-valid',
        scope: 'mcp',
        github_login: 'adam',
        github_id: 12345,
        created_at: baseTime,
        expires_at: baseTime + 86400000,
      });

      const result = refreshTokenStore.take(validHash);
      expect(result).toBeDefined();
      expect(result?.client_id).toBe('client-valid');

      nowSpy.mockRestore();
    });

    it('considers a token at exactly expiry time as expired', () => {
      const nowSpy = jest.spyOn(Date, 'now');
      const baseTime = 3000000;

      nowSpy.mockReturnValue(baseTime);

      const onTimeHash = 'ontime-token-hash';
      refreshTokenStore.save(onTimeHash, {
        client_id: 'client-ontime',
        scope: 'mcp',
        github_login: 'adam',
        github_id: 12345,
        created_at: baseTime - 10000,
        expires_at: baseTime,
      });

      const result = refreshTokenStore.take(onTimeHash);
      expect(result).toBeUndefined();

      nowSpy.mockRestore();
    });

    it('revokes a refresh token immediately', () => {
      const validHash = 'valid-to-revoke';
      refreshTokenStore.save(validHash, {
        client_id: 'client-revoke',
        scope: 'mcp',
        github_login: 'adam',
        github_id: 12345,
        created_at: Date.now(),
        expires_at: Date.now() + 86400000,
      });

      refreshTokenStore.revoke(validHash);

      const result = refreshTokenStore.take(validHash);
      expect(result).toBeUndefined();
    });

    it('persists expiry time correctly for long-lived tokens', () => {
      const nowSpy = jest.spyOn(Date, 'now');
      const baseTime = 3000000;
      const ttlMs = 7 * 24 * 60 * 60 * 1000; // 7 days

      nowSpy.mockReturnValue(baseTime);

      const longLivedHash = 'longterm-token-hash';
      const expiresAt = baseTime + ttlMs;

      refreshTokenStore.save(longLivedHash, {
        client_id: 'client-longterm',
        scope: 'mcp',
        github_login: 'adam',
        github_id: 12345,
        created_at: baseTime,
        expires_at: expiresAt,
      });

      // Check it exists shortly after
      nowSpy.mockReturnValue(baseTime + 1000);
      let result = refreshTokenStore.take(longLivedHash);
      expect(result).toBeDefined();

      // Re-save for next check
      refreshTokenStore.save(longLivedHash, {
        client_id: 'client-longterm',
        scope: 'mcp',
        github_login: 'adam',
        github_id: 12345,
        created_at: baseTime,
        expires_at: expiresAt,
      });

      // Move time forward but before expiry
      nowSpy.mockReturnValue(expiresAt - 1000);
      result = refreshTokenStore.take(longLivedHash);
      expect(result).toBeDefined();

      // Re-save for final check
      refreshTokenStore.save(longLivedHash, {
        client_id: 'client-longterm',
        scope: 'mcp',
        github_login: 'adam',
        github_id: 12345,
        created_at: baseTime,
        expires_at: expiresAt,
      });

      // Move time forward past expiry
      nowSpy.mockReturnValue(expiresAt + 1000);
      result = refreshTokenStore.take(longLivedHash);
      expect(result).toBeUndefined();

      nowSpy.mockRestore();
    });
  });

  describe('Multiple concurrent sweeps', () => {
    it('handles simultaneous auth code and pending request saves without race conditions', () => {
      const states: string[] = [];
      const codes: string[] = [];

      for (let i = 0; i < 5; i++) {
        const state = `state-${i}-${Date.now()}`;
        const code = `code-${i}-${Date.now()}`;
        states.push(state);
        codes.push(code);

        pendingRequestStore.save(state, {
          client_id: `client-${i}`,
          redirect_uri: `http://localhost/${i}`,
          code_challenge: 'challenge',
          code_challenge_method: 'S256',
          created_at: Date.now(),
        });

        authCodeStore.save(code, {
          client_id: `client-${i}`,
          redirect_uri: `http://localhost/${i}`,
          code_challenge: 'challenge',
          code_challenge_method: 'S256',
          github_login: `user${i}`,
          github_id: 10000 + i,
          created_at: Date.now(),
        });
      }

      // All should be retrievable
      for (let i = 0; i < 5; i++) {
        expect(pendingRequestStore.take(states[i])).toBeDefined();
        expect(authCodeStore.take(codes[i])).toBeDefined();
      }
    });
  });
});
