# durable-graphql

Auto-generated GraphQL API from Drizzle schema, running on Cloudflare Durable Objects with per-instance SQLite storage.

This project currently runs in **single-tenant mode** (one Durable Object instance), with JWT/auth handled in the Worker before requests reach the GraphQL runtime.

## Features

- Drizzle schema -> GraphQL schema generation
- Query, by-PK, cursor pagination, insert/update/delete operations
- Row-level and column-level authorization rules
- JWT auth (RS256 via JWKS, or HS256 shared secret)
- Durable Object + SQLite runtime on Cloudflare Workers
- Vitest unit + integration test coverage

## Quick Start

### 1. Install

```bash
pnpm install
```

### 2. Configure local env

```bash
cp .dev.vars.example .dev.vars
```

Update `.dev.vars` with real auth values.

### 3. Run locally

```bash
pnpm dev
```

GraphQL endpoint: `http://127.0.0.1:8787/graphql`  
GraphiQL: available at `/graphql` when `ENABLE_GRAPHIQL=true`.

## Scripts

- `pnpm dev` - start local Worker
- `pnpm deploy` - deploy with Wrangler
- `pnpm db:generate` - generate Drizzle migration + migration barrel
- `pnpm db:migrate` - run migrations
- `pnpm test` - run typecheck + all tests
- `pnpm test:unit` - unit tests only
- `pnpm test:integration` - integration tests only

## Auth Model

Worker auth is the trust boundary:

1. Worker verifies JWT/admin secret.
2. Worker injects trusted identity headers (`X-Role`, `X-User-Id`).
3. Durable Object executes GraphQL with permission rules.

Incoming `Authorization`, `X-Role`, `X-User-Id`, and `X-Admin-Secret` are stripped before forwarding.

## Repository Layout

- `src/` - runtime source
- `test/` - test suites
- `drizzle/` - generated migrations
- `permissions.config.ts` - default permission rules
- `wrangler.json` - Cloudflare Worker/DO config

## Open Source

- License: MIT (`LICENSE`)
- Security reporting: see `SECURITY.md`
- Contribution guide: see `CONTRIBUTING.md`
