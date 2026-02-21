import { describe, it, expect, beforeAll } from "vitest";
import { SignJWT, importJWK, errors as joseErrors, importPKCS8 } from "jose";
import { verifyJwt, decodeJwtHeader, JwtError } from "../src/auth/jwt.js";
import { authenticate, authMiddleware, clearJwksCache } from "../src/auth/middleware.js";

let keyPair: CryptoKeyPair;
let publicJwk: JsonWebKey;
let publicKey: CryptoKey;

/** Create a JWT signed with the test private key via jose. */
async function createTestJwt(
  payload: Record<string, unknown>,
  headerOverrides: { alg?: string; kid?: string } = {}
): Promise<string> {
  const alg = headerOverrides.alg ?? "RS256";
  const kid = headerOverrides.kid ?? "test-key-1";

  // For non-RS256 algs, we can't actually sign — build a fake token
  if (alg !== "RS256") {
    return buildFakeJwt({ alg, kid, typ: "JWT" }, payload);
  }

  let builder = new SignJWT(payload as Record<string, unknown>)
    .setProtectedHeader({ alg, kid, typ: "JWT" });

  return builder.sign(keyPair.privateKey);
}

/** Build a structurally valid but improperly signed JWT (for algorithm rejection tests). */
function buildFakeJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>
): string {
  const enc = (obj: Record<string, unknown>) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${enc(header)}.${enc(payload)}.fakesignature`;
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://auth.test.com/",
    aud: "test-api",
    exp: now + 3600,
    nbf: now - 60,
    sub: "user-123",
    role: "user",
    "user-id": "42",
    ...overrides,
  };
}

const baseEnv = {
  JWT_JWKS_URL: "https://auth.test.com/.well-known/jwks.json",
  JWT_ISSUER: "https://auth.test.com/",
  JWT_AUDIENCE: "test-api",
};

const verifyOpts = {
  issuer: "https://auth.test.com/",
  audience: "test-api",
};

/** Helper: mock JWKS fetch, run callback, restore. */
async function withMockJwks<T>(fn: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ keys: [{ ...publicJwk, kid: "test-key-1", use: "sig" }] }));
  try {
    clearJwksCache();
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

beforeAll(async () => {
  keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  publicKey = keyPair.publicKey;
});

describe("decodeJwtHeader", () => {
  it("decodes a well-formed token header", async () => {
    const token = await createTestJwt(validPayload());
    const header = decodeJwtHeader(token);
    expect(header.alg).toBe("RS256");
    expect(header.kid).toBe("test-key-1");
  });

  it("rejects tokens with no dot separator", () => {
    expect(() => decodeJwtHeader("nodots")).toThrow(JwtError);
  });

  it("rejects tokens with malformed base64 header", () => {
    expect(() => decodeJwtHeader("!!!.eyJ0ZXN0IjoxfQ.sig")).toThrow(JwtError);
  });
});

describe("verifyJwt", () => {
  it("verifies a valid token", async () => {
    const token = await createTestJwt(validPayload());
    const payload = await verifyJwt(token, publicKey, verifyOpts);
    expect(payload.iss).toBe("https://auth.test.com/");
    expect(payload.sub).toBe("user-123");
  });

  it("rejects invalid signature", async () => {
    const token = await createTestJwt(validPayload());
    const otherKeyPair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"]
    );
    await expect(verifyJwt(token, otherKeyPair.publicKey, verifyOpts)).rejects.toThrow("Invalid signature");
  });

  it("rejects disallowed algorithm", async () => {
    const token = await createTestJwt(validPayload(), { alg: "HS256" });
    await expect(verifyJwt(token, publicKey, verifyOpts)).rejects.toThrow(/[Aa]lgorithm not allowed/);
  });

  it("rejects expired token", async () => {
    const token = await createTestJwt(validPayload({ exp: Math.floor(Date.now() / 1000) - 120 }));
    await expect(verifyJwt(token, publicKey, verifyOpts)).rejects.toThrow("Token expired");
  });

  it("rejects not-yet-valid token (nbf)", async () => {
    const token = await createTestJwt(validPayload({ nbf: Math.floor(Date.now() / 1000) + 3600 }));
    await expect(verifyJwt(token, publicKey, verifyOpts)).rejects.toThrow(JwtError);
  });

  it("rejects wrong issuer", async () => {
    const token = await createTestJwt(validPayload({ iss: "https://evil.com/" }));
    await expect(verifyJwt(token, publicKey, verifyOpts)).rejects.toThrow(JwtError);
  });

  it("rejects wrong audience", async () => {
    const token = await createTestJwt(validPayload({ aud: "wrong-api" }));
    await expect(verifyJwt(token, publicKey, verifyOpts)).rejects.toThrow(JwtError);
  });

  it("rejects missing iss claim", async () => {
    const p = validPayload();
    delete p.iss;
    const token = await createTestJwt(p);
    await expect(verifyJwt(token, publicKey, verifyOpts)).rejects.toThrow(JwtError);
  });

  it("rejects missing aud claim", async () => {
    const p = validPayload();
    delete p.aud;
    const token = await createTestJwt(p);
    await expect(verifyJwt(token, publicKey, verifyOpts)).rejects.toThrow(JwtError);
  });

  it("rejects missing exp claim", async () => {
    const p = validPayload();
    delete p.exp;
    const token = await createTestJwt(p);
    await expect(verifyJwt(token, publicKey, verifyOpts)).rejects.toThrow(JwtError);
  });

  it("accepts token within clock skew tolerance", async () => {
    const token = await createTestJwt(validPayload({ exp: Math.floor(Date.now() / 1000) - 20 }));
    const payload = await verifyJwt(token, publicKey, { ...verifyOpts, clockSkewSeconds: 30 });
    expect(payload.sub).toBe("user-123");
  });

  it("accepts array audience containing expected value", async () => {
    const token = await createTestJwt(validPayload({ aud: ["other-api", "test-api"] }));
    const payload = await verifyJwt(token, publicKey, verifyOpts);
    expect(payload.sub).toBe("user-123");
  });
});

describe("authenticate - claims extraction", () => {
  it("extracts top-level claims with default keys (no config)", async () => {
    const token = await createTestJwt(validPayload());
    const request = new Request("https://example.com/graphql", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const headers = await withMockJwks(() => authenticate(request, { ...baseEnv }));
    expect(headers["X-Role"]).toBe("user");
    expect(headers["X-User-Id"]).toBe("42");
  });

  it("extracts claims from custom namespace", async () => {
    const token = await createTestJwt(validPayload({
      role: undefined,
      "user-id": undefined,
      "https://myapp.com/claims": {
        role: "editor",
        "user-id": "99",
        org: "acme",
      },
    }));
    const request = new Request("https://example.com/graphql", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const headers = await withMockJwks(() =>
      authenticate(request, {
        ...baseEnv,
        JWT_CLAIMS_NAMESPACE: "https://myapp.com/claims",
      })
    );
    expect(headers["X-Role"]).toBe("editor");
    expect(headers["X-User-Id"]).toBe("99");
    expect(headers["org"]).toBe("acme");
  });

  it("extracts claims with custom key names", async () => {
    const token = await createTestJwt(validPayload({
      role: undefined,
      "user-id": undefined,
      "https://clerk.dev/claims": {
        "x-hasura-role": "admin",
        "x-hasura-user-id": "clerk-777",
      },
    }));
    const request = new Request("https://example.com/graphql", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const headers = await withMockJwks(() =>
      authenticate(request, {
        ...baseEnv,
        JWT_CLAIMS_NAMESPACE: "https://clerk.dev/claims",
        JWT_CLAIMS_ROLE_KEY: "x-hasura-role",
        JWT_CLAIMS_USER_ID_KEY: "x-hasura-user-id",
      })
    );
    expect(headers["X-Role"]).toBe("admin");
    expect(headers["X-User-Id"]).toBe("clerk-777");
  });

  it("falls back to default-role key when role key is missing", async () => {
    const token = await createTestJwt(validPayload({
      role: undefined,
      "default-role": "viewer",
    }));
    const request = new Request("https://example.com/graphql", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const headers = await withMockJwks(() => authenticate(request, { ...baseEnv }));
    expect(headers["X-Role"]).toBe("viewer");
  });

  it("falls back to 'user' when neither role nor default-role exists", async () => {
    const token = await createTestJwt(validPayload({
      role: undefined,
      "user-id": "42",
    }));
    const request = new Request("https://example.com/graphql", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const headers = await withMockJwks(() => authenticate(request, { ...baseEnv }));
    expect(headers["X-Role"]).toBe("user");
  });

  it("forwards all string-valued claims as extra headers", async () => {
    const token = await createTestJwt(validPayload({
      "org-id": "org-123",
      "team": "backend",
    }));
    const request = new Request("https://example.com/graphql", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const headers = await withMockJwks(() => authenticate(request, { ...baseEnv }));
    expect(headers["org-id"]).toBe("org-123");
    expect(headers["team"]).toBe("backend");
  });

  it("does not allow claims to override reserved identity headers", async () => {
    const token = await createTestJwt(validPayload({
      role: "user",
      "user-id": "42",
      "X-Role": "admin",
      "X-User-Id": "999",
    }));
    const request = new Request("https://example.com/graphql", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const headers = await withMockJwks(() => authenticate(request, { ...baseEnv }));
    expect(headers["X-Role"]).toBe("user");
    expect(headers["X-User-Id"]).toBe("42");
    expect(headers["x-role"]).toBeUndefined();
    expect(headers["x-user-id"]).toBeUndefined();
  });

  it("does not forward case-variant reserved headers from claims", async () => {
    const token = await createTestJwt(validPayload({
      role: "user",
      "user-id": "42",
      "x-role": "admin",
      "x-user-id": "999",
      "X-ADMIN-SECRET": "malicious",
    }));
    const request = new Request("https://example.com/graphql", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const headers = await withMockJwks(() => authenticate(request, { ...baseEnv }));
    expect(headers["X-Role"]).toBe("user");
    expect(headers["X-User-Id"]).toBe("42");
    expect(headers["x-role"]).toBeUndefined();
    expect(headers["x-user-id"]).toBeUndefined();
    expect(headers["X-ADMIN-SECRET"]).toBeUndefined();
  });
});

describe("authenticate - clock skew validation", () => {
  it("rejects malformed JWT_CLOCK_SKEW_SECONDS with a clear config error", async () => {
    const token = await createTestJwt(validPayload());
    const request = new Request("https://example.com/graphql", {
      headers: { Authorization: `Bearer ${token}` },
    });

    await withMockJwks(() =>
      expect(
        authenticate(request, { ...baseEnv, JWT_CLOCK_SKEW_SECONDS: "abc" })
      ).rejects.toThrow(/Invalid JWT_CLOCK_SKEW_SECONDS/)
    );
  });

  it("rejects negative JWT_CLOCK_SKEW_SECONDS", async () => {
    const token = await createTestJwt(validPayload());
    const request = new Request("https://example.com/graphql", {
      headers: { Authorization: `Bearer ${token}` },
    });

    await expect(
      authenticate(request, { ...baseEnv, JWT_CLOCK_SKEW_SECONDS: "-5" })
    ).rejects.toThrow(/Invalid JWT_CLOCK_SKEW_SECONDS/);
  });

  it("maps malformed clock skew to 401 via authMiddleware", async () => {
    const token = await createTestJwt(validPayload());
    const request = new Request("https://example.com/graphql", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const result = await authMiddleware(request, {
      ...baseEnv,
      JWT_CLOCK_SKEW_SECONDS: "not-a-number",
    });

    expect(result).toBeInstanceOf(Response);
    const body = await (result as Response).json() as { error: string };
    expect((result as Response).status).toBe(401);
    expect(body.error).toContain("Invalid JWT_CLOCK_SKEW_SECONDS");
  });

  it("accepts valid JWT_CLOCK_SKEW_SECONDS", async () => {
    const token = await createTestJwt(validPayload());
    const request = new Request("https://example.com/graphql", {
      headers: { Authorization: `Bearer ${token}` },
    });

    const headers = await withMockJwks(() =>
      authenticate(request, { ...baseEnv, JWT_CLOCK_SKEW_SECONDS: "60" })
    );
    expect(headers["X-Role"]).toBe("user");
  });
});

describe("authenticate - header spoofing prevention", () => {
  it("strips caller-supplied X-User-Id when JWT has no user-id claim", async () => {
    const token = await createTestJwt(validPayload({ "user-id": undefined }));
    const request = new Request("https://example.com/graphql", {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-User-Id": "999",
        "X-Role": "admin",
      },
    });

    const headers = await withMockJwks(() => authenticate(request, { ...baseEnv }));
    expect(headers).toHaveProperty("X-User-Id");
    expect(headers["X-User-Id"]).toBe("");
  });
});

// --- HS256 helpers ---

const hs256Secret = "test-hs256-shared-secret-at-least-32-bytes!";

async function createHs256Jwt(
  payload: Record<string, unknown>,
  secret: string = hs256Secret
): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .sign(key);
}

const hs256Env = {
  JWT_SECRET: hs256Secret,
  JWT_ISSUER: "https://auth.test.com/",
  JWT_AUDIENCE: "test-api",
};

// --- Admin secret tests ---

describe("authenticate - admin secret", () => {
  const adminEnv = {
    ADMIN_SECRET: "super-secret-admin-key",
    JWT_JWKS_URL: "https://auth.test.com/.well-known/jwks.json",
    JWT_ISSUER: "https://auth.test.com/",
    JWT_AUDIENCE: "test-api",
  };

  it("grants admin role with matching secret", async () => {
    const request = new Request("https://example.com/graphql", {
      headers: { "X-Admin-Secret": "super-secret-admin-key" },
    });
    const headers = await authenticate(request, adminEnv);
    expect(headers["X-Role"]).toBe("admin");
    expect(headers["X-User-Id"]).toBe("");
  });

  it("rejects mismatched secret with 401", async () => {
    const request = new Request("https://example.com/graphql", {
      headers: { "X-Admin-Secret": "wrong-secret" },
    });
    await expect(authenticate(request, adminEnv)).rejects.toThrow("Invalid admin secret");
  });

  it("falls through to JWT when header is absent", async () => {
    const request = new Request("https://example.com/graphql");
    const headers = await withMockJwks(() => authenticate(request, adminEnv));
    expect(headers["X-Role"]).toBe("anonymous");
  });

  it("works even without JWT config", async () => {
    const request = new Request("https://example.com/graphql", {
      headers: { "X-Admin-Secret": "super-secret-admin-key" },
    });
    const headers = await authenticate(request, { ADMIN_SECRET: "super-secret-admin-key" });
    expect(headers["X-Role"]).toBe("admin");
  });
});

// --- HS256 JWT tests ---

describe("authenticate - HS256", () => {
  it("verifies a valid HS256 token and extracts claims", async () => {
    const token = await createHs256Jwt(validPayload());
    const request = new Request("https://example.com/graphql", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const headers = await authenticate(request, hs256Env);
    expect(headers["X-Role"]).toBe("user");
    expect(headers["X-User-Id"]).toBe("42");
  });

  it("rejects token signed with wrong secret", async () => {
    const token = await createHs256Jwt(validPayload(), "wrong-secret-that-is-long-enough!!");
    const request = new Request("https://example.com/graphql", {
      headers: { Authorization: `Bearer ${token}` },
    });
    await expect(authenticate(request, hs256Env)).rejects.toThrow(JwtError);
  });

  it("accepts token without kid in header", async () => {
    const token = await createHs256Jwt(validPayload());
    const header = JSON.parse(atob(token.split(".")[0]));
    expect(header.kid).toBeUndefined(); // HS256 tokens typically have no kid
    const request = new Request("https://example.com/graphql", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const headers = await authenticate(request, hs256Env);
    expect(headers["X-Role"]).toBe("user");
  });

  it("rejects when both JWT_SECRET and JWT_JWKS_URL are set", async () => {
    const token = await createHs256Jwt(validPayload());
    const request = new Request("https://example.com/graphql", {
      headers: { Authorization: `Bearer ${token}` },
    });
    await expect(
      authenticate(request, {
        ...hs256Env,
        JWT_JWKS_URL: "https://auth.test.com/.well-known/jwks.json",
      })
    ).rejects.toThrow("mutually exclusive");
  });

  it("returns anonymous for missing Authorization header", async () => {
    const request = new Request("https://example.com/graphql");
    const headers = await authenticate(request, hs256Env);
    expect(headers["X-Role"]).toBe("anonymous");
  });
});

describe("authMiddleware - error mapping", () => {
  it("returns 401 for malformed token (not 500)", async () => {
    const request = new Request("https://example.com/graphql", {
      headers: { Authorization: "Bearer not.a.valid.jwt" },
    });

    const result = await authMiddleware(request, { ...baseEnv });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  it("returns 401 for missing kid", async () => {
    const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const payload = btoa(JSON.stringify({ sub: "test" }))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const badToken = `${header}.${payload}.fakesig`;

    const request = new Request("https://example.com/graphql", {
      headers: { Authorization: `Bearer ${badToken}` },
    });

    const result = await authMiddleware(request, { ...baseEnv });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });
});
