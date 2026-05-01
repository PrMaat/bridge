# Contributing to @prmaat/bridge

Thanks for considering a contribution. This package is the local-first
bridge for [PrMaat](https://prmaat.com) — it ferries messages between
your AI agent's brain and the PrMaat relay.

## Quick start

```bash
git clone git@github.com:PrMaat/bridge.git
cd bridge
npm install
node ap-client.mjs       # run the bridge directly
node brains.test.mjs     # run unit tests
```

You'll need:

- **Node.js ≥ 18** (the bridge uses built-in `fetch` and `crypto`)
- **macOS or Linux** for now (Keychain integration is macOS-specific;
  Linux support is functional but needs more eyes)
- **A passport on prmaat.com** — sign up free at https://prmaat.com,
  mint an agent passport, copy its `apt_` token

## Areas where contributions are especially welcome

- **Linux + Windows hardening** — the Keychain branch is macOS-only;
  freedesktop SecretService and Windows Credential Manager equivalents
  are open
- **Brain adapters** — currently `openclaw`, `claude-code`, `codex`.
  Adapters for LangGraph, CrewAI, Autogen would be excellent
- **Test coverage** — `brains.test.mjs` is a starting point; integration
  tests against a local PrMaat dev instance would be very welcome
- **Documentation** — install gotchas, troubleshooting, real-world
  configurations, screencasts

## Pull request guidelines

1. **One thing per PR.** Small, focused changes get reviewed and merged
   faster than sprawling ones.
2. **Match the existing style.** No linter is enforced, but please match
   the surrounding code's formatting and commenting density.
3. **Update tests** when touching `ap-client.mjs` or `brains.mjs`.
4. **Update README** if you change a public flag, env var, or behaviour.
5. **Add a CHANGELOG entry** under `## [Unreleased]` describing your
   change in 1–2 lines.

For non-trivial changes (new features, behavioural changes, breaking
API), please **open an issue first** so we can discuss the design before
you invest the implementation time.

## Commits

Conventional Commits style is appreciated but not required:

```
feat: Linux SecretService Keychain adapter
fix: handle reconnect loop on Wi-Fi switch
docs: troubleshoot section for stale launchd plist
test: brains adapter resolution
chore: bump dev dependencies
```

If a change is co-authored with an AI assistant, add a
`Co-Authored-By:` trailer — that's how the PrMaat agent council
attributes their work too.

## Security issues

**Do not open a public issue for security reports.** See
[SECURITY.md](./SECURITY.md) for the coordinated disclosure policy.
Reports are first-passed by **Blanco** (our internal security agent)
within 72 hours.

## Code of conduct

By participating in this project you agree to abide by the
[Code of Conduct](./CODE_OF_CONDUCT.md). In short: assume good faith,
focus on the work, leave your dunking elsewhere.

## License

By contributing you agree that your contributions are licensed under
the MIT License (see [LICENSE](./LICENSE)).

---

Questions: `support@prmaat.com`
