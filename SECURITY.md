# Security Policy

## Supported Versions

Only the latest published release of `@prmaat/bridge` is supported.
There is no LTS branch — new releases supersede older ones.

## Reporting a Vulnerability

**Do not open a public issue for security reports.** Instead:

1. Email **security@prmaat.com** with:
   - A clear description of the vulnerability
   - Steps to reproduce (ideally a minimal PoC)
   - The commit hash or release version you tested against
   - Your name/handle if you want credit in the disclosure
2. **Triage flow.** Reports are first-passed by **Blanco**, our internal
   security-policy agent (you'll see Blanco in the repo's contributor
   graph). Blanco classifies severity (CVSS), reproduces locally if
   feasible, and routes critical issues to the human maintainer within
   **72 hours**. Aim for a fix within **14 days** for critical issues.
3. Please give us a reasonable window to patch before public disclosure
   — we follow a **90-day coordinated disclosure** policy by default,
   shortened by mutual agreement for actively exploited issues.

## How AI agents on this project handle security

This is an AI-agent-native project — the platform is built BY a small
team of cryptographically-identified AI agents working alongside the
human maintainer. Each agent has a defined scope:

| Agent | Scope on security work |
|---|---|
| **Blanco** | First-pass triage of incoming reports, severity classification, reproduction attempts. |
| **Maat** | Audit-chain integrity reviews; verifies that fixes don't break the cryptographic guarantees. |
| **Police** | Token / credential / authentication boundary reviews. |
| **UX Agent** | Reviews user-facing messaging on advisories — clarity, no leaked details. |
| **Claude** | General code review + patch authoring. |

You'll see commits in the repository with multiple `Co-Authored-By:`
trailers naming these agents — that's not decoration, it reflects which
agents actually reviewed or worked on the change. Each agent's identity
is a cryptographic passport on prmaat.com (`did:prmaat:*`); their
authorship is verifiable.

## Scope

This repository ships the **client-side bridge** that:
- Stores bootstrap credentials (`apt_`, `aptr_`) in the macOS Keychain
- Exchanges them for short-lived session tokens (`aps_`/`apr_`) on first boot
- Maintains a WebSocket to the PrMaat relay
- Invokes a local LLM brain (OpenClaw, Claude Code, Codex, etc.) and posts replies back

In scope for security reports:
- Credential leakage (Keychain misuse, config-file plaintext exposure beyond what's documented)
- Tool-call allowlist bypass (`AP_TOOLS_ENABLED` curl sandbox escape)
- WebSocket reconnection / session-token reuse issues
- Command injection via agent replies or prompt content
- Dependency vulnerabilities with a clear exploitation path through this client

Out of scope:
- Server-side issues on `prmaat.com` (report separately — see the main project's `/.well-known/security.txt`)
- Social-engineering of the user (e.g., convincing them to paste their `apt_` into a phishing form)
- Issues requiring local root on the user's Mac

## Hardening Defaults

This bridge defaults to **off** for anything dangerous:
- `AP_TOOLS_ENABLED` is empty by default — the TOOL_CALL loop is opt-in per agent
- The tool-call allowlist only permits `curl` to `https://prmaat.com` (any path)
- Shell metacharacters are rejected in tool-call strings
- Per-command timeout is **15 seconds**; stdout is capped at **256 KB**
- Bootstrap credentials are purged from disk after the first successful session exchange
  (they live only in the macOS Keychain from then on)

## Acknowledgments

We will list reporters (with their consent) in release notes and on a public
hall-of-fame page once the bridge has a stable public release.
