/**
 * JWKS key resolution via `jose` library.
 * Uses createRemoteJWKSet for automatic fetching, caching, and key rotation.
 */

import { createRemoteJWKSet } from "jose";
import type { FlattenedJWSInput, JWSHeaderParameters } from "jose";
import { JwtError } from "./jwt.js";

type KeySetFunction = (
  protectedHeader?: JWSHeaderParameters,
  token?: FlattenedJWSInput
) => Promise<CryptoKey>;

let cachedKeySet: { url: string; fn: KeySetFunction } | null = null;

/**
 * Get a JWKS key resolver for the given URL.
 * jose handles caching, key rotation, and rate limiting internally.
 */
export function getJwksKeySet(jwksUrl: string): KeySetFunction {
  if (cachedKeySet && cachedKeySet.url === jwksUrl) {
    return cachedKeySet.fn;
  }

  const fn = createRemoteJWKSet(new URL(jwksUrl)) as unknown as KeySetFunction;
  cachedKeySet = { url: jwksUrl, fn };
  return fn;
}

/**
 * Resolve a signing key by kid from a JWKS endpoint.
 * Returns a CryptoKey ready for verification.
 */
export async function getSigningKey(
  jwksUrl: string,
  kid: string
): Promise<CryptoKey> {
  const keySet = getJwksKeySet(jwksUrl);
  try {
    return await keySet({ kid, alg: "RS256" });
  } catch (err) {
    throw new JwtError(
      `Failed to resolve signing key (kid: ${kid}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Clear the cached key set (useful for testing). */
export function clearJwksCache(): void {
  cachedKeySet = null;
}
