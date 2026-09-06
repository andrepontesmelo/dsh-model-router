# Contributing

Thanks for looking at dsh-model-router. PRs welcome.

## Workflow

1. Fork / branch from `main`.
2. Make the change with a test that pins it (`test/`, `node --test`).
3. Run the local gate:

   ```bash
   npm test        # unit suite
   npm run smoke   # LOCAL failover drills — zero network, zero keys
   ```

4. Open a PR describing what changed and why.

CI runs the same gate on Node 22; a PR is mergeable when both are green.

## Ground rules

- ESM only, Node ≥ 22, no transpile step, no new runtime dependencies without discussion.
- `select` in a routing algorithm stays pure — see
  [docs/architecture.md](docs/architecture.md) and the contract comment in
  [lib/routing.js](lib/routing.js).
- Glossary terms from [CONTEXT.md](CONTEXT.md) are used verbatim in comments, tests and
  errors.
- Update [docs/](docs/index.md) when the config surface or a contract changes.

## Reporting bugs

Open a GitHub issue with: DSH + plugin versions, the route config (redact provider keys —
config contains provider/model names only, never credentials), and either the `NO_CANDIDATE`
error text or the provenance chain showing the failed attempts.

## Security

See [SECURITY.md](SECURITY.md) — please do not open public issues for security reports.
