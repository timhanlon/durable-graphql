# Contributing

## Development Setup

1. Install dependencies:
```bash
pnpm install
```
2. Copy env template:
```bash
cp .dev.vars.example .dev.vars
```
3. Start local runtime:
```bash
pnpm dev
```

## Validation

Run before opening a PR:

```bash
pnpm test
```

## Pull Requests

- Keep PRs focused and minimal.
- Add or update tests for behavior changes.
- Document user-facing changes in `README.md` when relevant.

## Commit Style

Any clear commit style is acceptable. Prefer concise, imperative messages.
