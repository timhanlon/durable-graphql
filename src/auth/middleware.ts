/**
 * Auth middleware for the Worker layer.
 * Verifies JWT via jose, extracts claims from configurable namespace/keys, injects trusted headers to DO.
 */

import { jwtVerify } from "jose";
import type { JWTPayload } from "jose";
import { decodeJwtHeader, JwtError } from "./jwt.js";
import { getJwksKeySet, clearJwksCache } from "./jwks.js";

export { clearJwksCache };

interface AuthEnv {
  /** Shared secret for admin bypass (server-to-server, CI/CD) */
  ADMIN_SECRET?: string;
  /** HS256 shared secret (alternative to JWT_JWKS_URL) */
  JWT_SECRET?: string;
  /** JWKS endpoint URL (e.g., https://auth.example.com/.well-known/jwks.json) */
  JWT_JWKS_URL?: string;
  /** Required JWT issuer */
  JWT_ISSUER?: string;
  /** Required JWT audience */
  JWT_AUDIENCE?: string;
  /** Clock skew tolerance in seconds */
  JWT_CLOCK_SKEW_SECONDS?: string;
  /** JWT key holding claims object; omit for top-level claims */
  JWT_CLAIMS_NAMESPACE?: string;
  /** Key within claims for role (default: "role") */
  JWT_CLAIMS_ROLE_KEY?: string;
  /** Fallback role key within claims (default: "default-role") */
  JWT_CLAIMS_DEFAULT_ROLE_KEY?: string;
  /** Key within claims for user ID (default: "user-id") */
  JWT_CLAIMS_USER_ID_KEY?: string;
}

export interface AuthResult {
  role: string;
  userId: string | null;
  extraHeaders: Record<string, string>;
}

const RESERVED_HEADER_NAMES = new Set([
  "authorization",
  "x-admin-secret",
  "x-role",
  "x-user-id",
]);

/** Extract claims from JWT payload using configured namespace and key names. */
function extractClaims(payload: JWTPayload, env: AuthEnv): AuthResult {
  const namespace = env.JWT_CLAIMS_NAMESPACE;
  const claims: Record<string, unknown> = namespace
    ? ((payload[namespace] as Record<string, unknown>) ?? {})
    : { ...payload };

  const roleKey = env.JWT_CLAIMS_ROLE_KEY || "role";
  const defaultRoleKey = env.JWT_CLAIMS_DEFAULT_ROLE_KEY || "default-role";
  const userIdKey = env.JWT_CLAIMS_USER_ID_KEY || "user-id";

  const role =
    (claims[roleKey] as string) ??
    (claims[defaultRoleKey] as string) ??
    "user";

  const userId = (claims[userIdKey] as string) ?? null;

  const extraHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(claims)) {
    if (typeof value === "string" && !RESERVED_HEADER_NAMES.has(key.toLowerCase())) {
      extraHeaders[key] = value;
    }
  }

  return { role, userId, extraHeaders };
}

/** Constant-time string comparison to prevent timing attacks. */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) return false;
  // Workers runtime has crypto.subtle.timingSafeEqual; Node.js does not.
  const subtle = crypto?.subtle as SubtleCrypto & {
    timingSafeEqual?: (left: BufferSource, right: BufferSource) => boolean;
  };
  if (typeof subtle?.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(aBuf, bBuf);
  }
  // Fallback: constant-time comparison via HMAC equality
  let result = 0;
  for (let i = 0; i < aBuf.byteLength; i++) {
    result |= aBuf[i] ^ bBuf[i];
  }
  return result === 0;
}

/**
 * Authenticate a request. Returns headers to inject into the DO request.
 * Throws JwtError on auth failure.
 */
export async function authenticate(
  request: Request,
  env: AuthEnv
): Promise<Record<string, string>> {
  // --- Admin secret bypass ---
  const adminSecretHeader = request.headers.get("X-Admin-Secret");
  if (env.ADMIN_SECRET && adminSecretHeader) {
    if (timingSafeEqual(adminSecretHeader, env.ADMIN_SECRET)) {
      return { "X-Role": "admin", "X-User-Id": "" };
    }
    throw new JwtError("Invalid admin secret");
  }

  // --- JWT config validation ---
  if (env.JWT_SECRET && env.JWT_JWKS_URL) {
    throw new JwtError(
      "Invalid JWT configuration: JWT_SECRET and JWT_JWKS_URL are mutually exclusive"
    );
  }
  if (!env.JWT_SECRET && !env.JWT_JWKS_URL) {
    throw new JwtError(
      "JWT configuration missing: either JWT_SECRET or JWT_JWKS_URL is required"
    );
  }
  if (!env.JWT_ISSUER || !env.JWT_AUDIENCE) {
    throw new JwtError(
      "JWT configuration missing: JWT_ISSUER and JWT_AUDIENCE are required"
    );
  }

  const authHeader = request.headers.get("Authorization");
  if (!authHeader) {
    return { "X-Role": "anonymous", "X-User-Id": "" };
  }

  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new JwtError("Invalid Authorization header: expected Bearer <token>");
  }
  const token = match[1];

  // Parse clock skew (shared by both paths)
  let clockSkew = 30;
  if (env.JWT_CLOCK_SKEW_SECONDS) {
    clockSkew = parseInt(env.JWT_CLOCK_SKEW_SECONDS, 10);
    if (!Number.isFinite(clockSkew) || clockSkew < 0) {
      throw new JwtError(
        `Invalid JWT_CLOCK_SKEW_SECONDS: "${env.JWT_CLOCK_SKEW_SECONDS}" (must be a non-negative integer)`
      );
    }
  }

  let payload: JWTPayload;

  if (env.JWT_SECRET) {
    // --- HS256 path ---
    try {
      const secret = new TextEncoder().encode(env.JWT_SECRET);
      const result = await jwtVerify(token, secret, {
        algorithms: ["HS256"],
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
        clockTolerance: clockSkew,
        requiredClaims: ["iss", "aud", "exp"],
      });
      payload = result.payload;
    } catch (err) {
      if (err instanceof JwtError) throw err;
      throw new JwtError(
        err instanceof Error ? err.message : "Token verification failed"
      );
    }
  } else {
    // --- RS256/JWKS path ---
    // Decode header to validate kid exists (fail fast before JWKS fetch)
    const header = decodeJwtHeader(token);
    if (!header.kid) {
      throw new JwtError("Missing required kid in JWT header");
    }

    try {
      const keySet = getJwksKeySet(env.JWT_JWKS_URL!);
      const result = await jwtVerify(token, keySet, {
        algorithms: ["RS256"],
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
        clockTolerance: clockSkew,
        requiredClaims: ["iss", "aud", "exp"],
      });
      payload = result.payload;
    } catch (err) {
      if (err instanceof JwtError) throw err;
      throw new JwtError(
        err instanceof Error ? err.message : "Token verification failed"
      );
    }
  }

  const { role, userId, extraHeaders } = extractClaims(payload, env);

  return {
    "X-Role": role,
    "X-User-Id": userId ?? "",
    ...extraHeaders,
  };
}

/** Wrap authenticate into an error response if needed. */
export async function authMiddleware(
  request: Request,
  env: AuthEnv
): Promise<{ headers: Record<string, string> } | Response> {
  try {
    const headers = await authenticate(request, env);
    return { headers };
  } catch (err) {
    if (err instanceof JwtError) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw err;
  }
}
