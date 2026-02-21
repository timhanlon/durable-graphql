/**
 * JWT verification via `jose` library. RS256 only.
 * Wraps jose errors into our JwtError for consistent 401 handling.
 */

import { jwtVerify, errors as joseErrors } from "jose";
import type { JWTPayload, JWTVerifyResult } from "jose";

export type { JWTPayload };

export interface VerifyOptions {
  /** Required issuer — token must match exactly */
  issuer: string;
  /** Required audience — token aud must contain this value */
  audience: string;
  /** Clock skew tolerance in seconds (default: 30) */
  clockSkewSeconds?: number;
}

const ALLOWED_ALGORITHMS = ["RS256"] as const;

/**
 * Verify a JWT against a CryptoKey. Returns the payload on success.
 * Throws JwtError on any failure (expired, bad signature, wrong claims, etc.).
 */
export async function verifyJwt(
  token: string,
  publicKey: CryptoKey | Uint8Array,
  options: VerifyOptions
): Promise<JWTPayload> {
  try {
    const result: JWTVerifyResult = await jwtVerify(token, publicKey, {
      algorithms: [...ALLOWED_ALGORITHMS],
      issuer: options.issuer,
      audience: options.audience,
      clockTolerance: options.clockSkewSeconds ?? 30,
      requiredClaims: ["iss", "aud", "exp"],
    });
    return result.payload;
  } catch (err) {
    throw toJwtError(err);
  }
}

/** Decode a JWT header without verification (to extract `kid`). */
export function decodeJwtHeader(token: string): { alg: string; kid?: string } {
  const dot = token.indexOf(".");
  if (dot === -1) throw new JwtError("Malformed token: expected 3 segments");
  try {
    const headerJson = atob(
      token.slice(0, dot).replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - (dot % 4)) % 4)
    );
    return JSON.parse(headerJson);
  } catch {
    throw new JwtError("Malformed token: invalid header");
  }
}

/** Map jose errors to our JwtError for consistent 401 handling. */
function toJwtError(err: unknown): JwtError {
  if (err instanceof JwtError) return err;
  if (err instanceof joseErrors.JWTExpired) return new JwtError("Token expired");
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    return new JwtError(`Claim validation failed: ${err.message}`);
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
    return new JwtError("Invalid signature");
  }
  if (err instanceof joseErrors.JOSEAlgNotAllowed) {
    return new JwtError(`Algorithm not allowed: ${err.message}`);
  }
  if (err instanceof joseErrors.JWTInvalid) {
    return new JwtError(`Invalid token: ${err.message}`);
  }
  if (err instanceof joseErrors.JOSEError) {
    return new JwtError(err.message);
  }
  if (err instanceof Error) return new JwtError(err.message);
  return new JwtError("Unknown JWT error");
}

export class JwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JwtError";
  }
}
