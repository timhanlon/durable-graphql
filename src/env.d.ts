/** Augment the auto-generated Env with auth vars. */
declare interface Env {
  ENABLE_GRAPHIQL?: string;
  ADMIN_SECRET?: string;
  JWT_SECRET?: string;
  JWT_JWKS_URL?: string;
  JWT_ISSUER?: string;
  JWT_AUDIENCE?: string;
  JWT_CLOCK_SKEW_SECONDS?: string;
  JWT_CLAIMS_NAMESPACE?: string;
  JWT_CLAIMS_ROLE_KEY?: string;
  JWT_CLAIMS_DEFAULT_ROLE_KEY?: string;
  JWT_CLAIMS_USER_ID_KEY?: string;
}
