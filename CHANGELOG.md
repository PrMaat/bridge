# Changelog

All notable changes to `@prmaat/bridge` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Planned
- Linux SecretService Keychain adapter (currently macOS-only Keychain)
- Multi-region relay endpoint selection
- Optional Hosted Brain v4 fallback when local brain is unavailable

## [0.3.0] — 2026-04-29

### Changed
- **Renamed npm scope** from `@myclawpassport/bridge` to `@prmaat/bridge`.
  The `@myclawpassport/bridge` package on npm is now a deprecation stub
  that re-exports `@prmaat/bridge` so existing installs keep working
  while we transition.
- **Renamed default config path** from `myclawpassport-bridge.json` to
  `ap-client.json` with auto-migration from the old location.
- **Brand:** the project was originally scoped specifically to OpenClaw
  users; this release broadens it to any agent runtime (Claude Code,
  Cursor, Codex, OpenClaw, custom). `did:myclawpassport:*` DIDs
  continue to resolve and verify forever (cryptographic identity is
  preserved).

### Added
- `brainclaw connect` — OAuth-style one-line enrollment that opens
  prmaat.com in the browser, pairs the device, stashes secrets in
  macOS Keychain, generates a launchd plist, and loads the bridge in
  ~30 seconds.
- `brainclaw bridge list` and `brainclaw doctor` for cross-bridge
  observability on the local machine.
- T1.5 auto-rotate: the bridge now polls token TTL every 6 hours and
  uses the rotate-scoped `aptr_` to refresh `apt_` before expiry,
  fully transparent to the user.

### Fixed
- Reconnect storm when Wi-Fi switches networks mid-session.
- Stale launchd plist that wouldn't reload on `brainclaw connect`
  re-enrollment.

## [0.2.0] — 2026-03-15 (legacy `@myclawpassport/bridge`)

### Added
- OAuth-style `brainclaw connect` flow.
- Crash-resilient per-agent bootstrap.
- Auto-migration from legacy install paths.

## [0.1.0] — 2026-02-20 (legacy `@myclawpassport/bridge`)

Initial public release as `@myclawpassport/bridge`. Per-creator launchd
plists, manual `apt_/aptr_` config, single-machine multi-agent support.

[Unreleased]: https://github.com/PrMaat/bridge/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/PrMaat/bridge/releases/tag/v0.3.0
