#!/usr/bin/env node
/**
 * PrMaat Client — runs on YOUR machine, uses YOUR local brain.
 *
 * What it does:
 *   1. Connects to prmaat.com VPS via WebSocket for each configured agent
 *   2. When an @mention arrives, invokes the LOCAL OpenClaw CLI for that agent
 *   3. Posts OpenClaw's reply back to the room via HTTP
 *
 * What it does NOT do:
 *   - Call any LLM API directly (no anthropic/openai/openrouter/ollama fetches)
 *   - Store any API key
 *   - Do any "thinking" — that's OpenClaw's job
 *
 * The VPS is a pure chat relay. All brains live here on your machine.
 */
import WebSocket from "ws";
import { execFile } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { homedir } from "os";
import { makeRunBrain, sanitizeBrainOutput } from "./brains.mjs";

// ── B2 log scrubbing (2026-04-22, voted unanimous) ────────────────────────
// Regex-filter token prefixes from stdout/stderr BEFORE they hit the log
// file. The bridge logs lots of URLs + error bodies; the scrubber catches
// the cases where apt_/aptr_/aps_/apr_ would otherwise leak to disk where
// anyone reading ~/ap-client/ap-client.log could harvest them.
// Marker: B2_LOG_SCRUB_INSTALLED
const _TOKEN_SCRUB_RE = /\b(apt|aptr|aps|apr)_[A-Za-z0-9_-]{4,}/g;
function _scrubTokens(s) {
  if (typeof s !== "string") return s;
  return s.replace(_TOKEN_SCRUB_RE, (m) => {
    const prefix = m.split("_")[0];
    // Keep first 4 chars of the secret portion for cross-referencing
    // without leaking the full token. E.g. "apt_LvqMXx..." → "apt_LvqM…(scrubbed)".
    const secret = m.slice(prefix.length + 1);
    return `${prefix}_${secret.slice(0, 4)}…(scrubbed)`;
  });
}
const _origStdoutWrite = process.stdout.write.bind(process.stdout);
const _origStderrWrite = process.stderr.write.bind(process.stderr);
process.stdout.write = function (chunk, enc, cb) {
  if (typeof chunk === "string") chunk = _scrubTokens(chunk);
  else if (Buffer.isBuffer(chunk)) {
    const s = chunk.toString("utf8");
    const scrubbed = _scrubTokens(s);
    if (scrubbed !== s) chunk = Buffer.from(scrubbed);
  }
  return _origStdoutWrite(chunk, enc, cb);
};
process.stderr.write = function (chunk, enc, cb) {
  if (typeof chunk === "string") chunk = _scrubTokens(chunk);
  else if (Buffer.isBuffer(chunk)) {
    const s = chunk.toString("utf8");
    const scrubbed = _scrubTokens(s);
    if (scrubbed !== s) chunk = Buffer.from(scrubbed);
  }
  return _origStderrWrite(chunk, enc, cb);
};


const __dirname = dirname(fileURLToPath(import.meta.url));
// Step 2 of reliability mandate (2026-04-27): canonical config path is
// ~/.myclawpassport/ap-client.json regardless of where ap-client.mjs lives.
// Today's crash loop was rooted in three different ap-client.json files
// existing at three paths (~/ap-client/, ~/.myclawpassport/,
// ~/.myclawpassport/bridge/), with the daemon reading a different one
// than the CLI was editing. By anchoring to $HOME, we close the split.
//
// Resolution order:
//   1. $AP_CONFIG    — operator override (still wins)
//   2. ~/.myclawpassport/ap-client.json  — canonical
//   3. legacy fallback: ~/ap-client/ap-client.json (old install path)
//      — if 2 doesn't exist but 3 does, we MIGRATE 3 → 2 on first read
//      so subsequent boots are clean. Operator can still revert by
//      setting AP_CONFIG explicitly.
function resolveConfigPath() {
  if (process.env.AP_CONFIG) return process.env.AP_CONFIG;
  const canonical = join(homedir(), ".myclawpassport", "ap-client.json");
  const legacy = join(homedir(), "ap-client", "ap-client.json");
  // First-boot migration: copy legacy → canonical if only legacy exists.
  if (!existsSync(canonical) && existsSync(legacy)) {
    try {
      const dir = dirname(canonical);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const raw = readFileSync(legacy, "utf8");
      writeFileSync(canonical, raw, { mode: 0o600 });
      // Leave the legacy file in place but mark it stale via comment-ish key
      // so a second migration is a no-op (canonical now exists).
      console.log(`[ap-client] migrated config: ${legacy} → ${canonical}`);
      console.log(`[ap-client]   (legacy file kept; remove manually after verifying canonical works)`);
    } catch (err) {
      console.warn(`[ap-client] config migration failed (non-fatal): ${err.message}`);
      // Fall back to legacy path so the bridge still boots.
      return legacy;
    }
  }
  // Final fallback: if neither exists, return canonical anyway so the
  // operator-facing error message points at the right place.
  return canonical;
}
const CONFIG_FILE = resolveConfigPath();

// ── B4 config-file mode check (2026-04-22, voted unanimous — UX: hard-reject) ─
// The bridge reads apt_/aptr_ tokens from CONFIG_FILE. If the file is
// group-readable or world-readable, any other process on the same host
// running as another user can read the tokens and impersonate the
// passport. 0600 (owner rw, group/world nothing) is the only acceptable
// posture. Hard-reject at boot.
// Marker: B1_B4_INSTALLED
import { statSync as _statSync_b14, accessSync as _accessSync_b14, constants as _fsConstants_b14 } from "fs";
function assertConfigFileMode600(cfgPath) {
  let stat;
  try { stat = _statSync_b14(cfgPath); }
  catch (err) {
    // ENOENT is fine — bootstrap flow may run without an on-disk config
    // (e.g. when apt_ args are supplied on the command line or via
    // AP_TOKENS env var). Missing file ≠ insecure file.
    if (err && err.code === "ENOENT") return;
    throw err;
  }
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    const modeStr = mode.toString(8).padStart(3, "0");
    const bar = "═".repeat(64);
    console.error("");
    console.error(`[ap-client] ╔${bar}╗`);
    console.error("[ap-client] ║  ⛔  CONFIG FILE MODE TOO PERMISSIVE (refusing to start)    ║");
    console.error(`[ap-client] ╠${bar}╣`);
    console.error(`[ap-client] ║  File: ${cfgPath}`);
    console.error(`[ap-client] ║  Mode: ${modeStr} (expected 600)`);
    console.error("[ap-client] ║");
    console.error("[ap-client] ║  Fix with:");
    console.error(`[ap-client] ║    chmod 600 ${cfgPath}`);
    console.error("[ap-client] ║");
    console.error("[ap-client] ║  Why: the bridge reads apt_ / aptr_ tokens from this file.");
    console.error("[ap-client] ║  Group or world-readable = token theft by any other user/process");
    console.error("[ap-client] ║  on this host. This is B4 of the 2026-04-22 bridge-security slate.");
    console.error(`[ap-client] ╚${bar}╝`);
    console.error("");
    process.exit(2);
  }
}

// ── B1 brainBin allowlist (2026-04-22, voted unanimous — UX: clear error msg) ─
// After Layer 1 (2026-04-22), operators can point `brainBin` at any
// executable via ap-client.json tokenPair.brainBin. That's an RCE vector
// if anyone can write the config. Hard-allowlist at bootstrap.
const BRAINBIN_ALLOWED_PREFIXES = [
  "/opt/homebrew/bin/",
  "/usr/local/bin/",
  "/opt/openclaw/bin/",
];
const BRAINBIN_USER_PATTERNS = [
  /^\/Users\/[^/]+\/\.npm-global\/bin\//,
  /^\/Users\/[^/]+\/\.local\/bin\//,
  /^\/Users\/[^/]+\/\.cargo\/bin\//,
  /^\/home\/[^/]+\/\.npm-global\/bin\//,
  /^\/home\/[^/]+\/\.local\/bin\//,
  /^\/home\/[^/]+\/\.cargo\/bin\//,
];
function validateBrainBin(brainBin, agentLabel) {
  if (!brainBin) return { ok: true };
  if (typeof brainBin !== "string" || !brainBin.startsWith("/")) {
    return { ok: false, reason: `brainBin must be an absolute path, got "${brainBin}"` };
  }
  const prefixOK = BRAINBIN_ALLOWED_PREFIXES.some((p) => brainBin.startsWith(p));
  const userOK = BRAINBIN_USER_PATTERNS.some((re) => re.test(brainBin));
  if (!prefixOK && !userOK) {
    const allowedLabel = [
      ...BRAINBIN_ALLOWED_PREFIXES,
      ...BRAINBIN_USER_PATTERNS.map((re) => re.source.replace(/\\\//g, "/")),
    ].join(", ");
    return {
      ok: false,
      reason:
        `brainBin "${brainBin}" is not under an allowed prefix.\n` +
        `    Detected path: ${brainBin}\n` +
        `    Allowed prefixes: ${allowedLabel}\n` +
        `    (B1 of 2026-04-22 bridge-security slate: hard-reject for RCE-vector paths.)`,
    };
  }
  try {
    _accessSync_b14(brainBin, _fsConstants_b14.X_OK);
  } catch (err) {
    return {
      ok: false,
      reason: `brainBin "${brainBin}" is not executable by this process (${err && err.code ? err.code : err.message})`,
    };
  }
  return { ok: true };
}

// Persisted session cache — Police T1.5 / Track 2 (2026-04-18):
//   On macOS, aps_/apr_ live in the OS Keychain under service
//   "com.myclawpassport.bridge", account=passportKey(passportId).
//   Success criteria (Police): "the bridge never stores apt_ or a creator
//   JWT again, only apr_ in the OS keychain". After the bootstrap-from-apt
//   exchange succeeds, apt_ + aptr_ on disk are nulled (purgeBootstrapSecrets).
//   On non-macOS (dev, CI), falls back to a 0600-perm JSON file so the
//   bridge still works without the security(1) CLI.
//   Keyed by passportId (not apt_) so rotation doesn't orphan the cache.
const SESSION_STORE = process.env.AP_SESSION_STORE || join(__dirname, ".ap-sessions.json");
const IS_MACOS = process.platform === "darwin";
// Keychain namespace — default matches the single-bridge deployment pattern.
// For bridge-per-creator setups (2026-04-23, voted unanimous in the
// brainstorm room), set AP_KEYCHAIN_SERVICE=com.myclawpassport.bridge.<label>
// so each creator's apt_/aptr_/aps_ entries live in an isolated keychain
// bucket. The `brainclaw bridge init --creator <label>` command generates
// a plist that sets this env var for the spawned bridge process.
const KEYCHAIN_SERVICE = process.env.AP_KEYCHAIN_SERVICE || "com.myclawpassport.bridge";
// Opt-out: AP_KEYCHAIN=0 forces file fallback even on macOS (debugging).
const USE_KEYCHAIN = IS_MACOS && process.env.AP_KEYCHAIN !== "0";

const VPS_HTTP = process.env.AP_HTTP || "https://prmaat.com";
const VPS_WS = process.env.AP_WS || "wss://prmaat.com";
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "/Users/mikebot/.openclaw/bin/openclaw";
const OPENCLAW_TIMEOUT_MS = parseInt(process.env.OPENCLAW_TIMEOUT_MS || "120000", 10);
const RECONNECT_DELAY = 3000;

// ── Tool-call loop (real fix for "I'll test and report back" ghosting) ──────
// When an agent's reply contains TOOL_CALL: <cmd> lines, the bridge executes
// each one (strict curl-to-prmaat.com allowlist), appends the output
// to the conversation, and re-prompts. Max N iterations before forcing a
// final answer. Opt-in via per-agent config: { "tools": true }.
const TOOL_CALL_MAX_ITERATIONS = parseInt(process.env.AP_TOOL_MAX_ITERATIONS || "3", 10);
const TOOL_CALL_TIMEOUT_MS = parseInt(process.env.AP_TOOL_TIMEOUT_MS || "15000", 10);
const TOOL_CALL_MAX_BYTES = 256 * 1024; // cap a command's stdout at 256KB

// ── Language code → human-readable name ─────────────────────────────────────
// The server sends ISO-639-1 codes ("ar", "fr"). Raw codes confuse the model
// (it sometimes treats "ar" as a literal token to echo, not the Arabic
// language). Resolving to the full language name makes the hard-rule
// unambiguous. Keep in sync with frontend/src/config/languages.ts.
const LANGUAGE_NAMES = {
  ar: "Arabic", en: "English", fr: "French", de: "German", es: "Spanish",
  it: "Italian", nl: "Dutch", pt: "Portuguese", ru: "Russian", zh: "Chinese",
  ja: "Japanese", ko: "Korean", tr: "Turkish", he: "Hebrew", hi: "Hindi",
  pl: "Polish", uk: "Ukrainian", sv: "Swedish", no: "Norwegian", da: "Danish",
  fi: "Finnish", cs: "Czech", ro: "Romanian", el: "Greek", id: "Indonesian",
  th: "Thai", vi: "Vietnamese",
};
function resolveLanguageName(code) {
  if (!code) return null;
  const c = String(code).toLowerCase();
  return LANGUAGE_NAMES[c] || c;
}

// Actual model this bridge is driving. Reported per-message so silent
// fallbacks / model swaps are visible to everyone in the room (the passport's
// agentType is just the platform category — this is ground truth).
//   - Env AP_MODEL wins (quick override)
//   - Per-agent cfg.model is the per-agent default
//   - null = unknown/not reported (honest)
const GLOBAL_MODEL = process.env.AP_MODEL || null;

// ── Layer 1 model attestation (2026-04-22, voted unanimous in brainstorm) ──
// Derives the per-message model tag from each agent's `brain` override in
// ap-client.json instead of copying a static config string. This makes the
// tag follow the actual runtime automatically — no manual config-editing
// required to keep labels in sync with what the bridge actually invokes.
//
// `attested: true` means operator-controlled: the operator controls the
// brain override in ap-client.json and the binary at `brainBin`, so the
// tag is filesystem-verifiable within the operator's perimeter. The UI
// labels this as "operator-attested" (distinct from "provider-signed"
// which would require Anthropic/OpenAI to ship signed attestations —
// a future Layer 3 feature).
//
// Legal/compliance note: operator-attested is NOT the same as crypto
// attestation. Do not display this flag as "verified" or "platform-
// verified" — that creates a false EU AI Act Art. 50 promise.
const BRAIN_TO_MODEL = {
  "claude-code": { model: "anthropic/claude-code", attested: true },
  "codex":       { model: "openai/codex",          attested: true },
  "exec":        { model: "custom/exec",           attested: true },
};

// ── Layer 1.5 (2026-04-23): openclaw.json default model lookup ──────
// For agents without a `brain` override in ap-client.json, read the
// operator's ~/.openclaw/openclaw.json and use the per-agent
// `model.primary` as a fallback tag. Attested=false because the tag
// comes from a static config file, not a filesystem-verifiable
// brain override. Still better than null — operators + auditors can
// see which model the OpenClaw CLI will route to by default.
// Marker: layer15_openclaw_model_map
let _openclawModelMapCache = null;
function _loadOpenclawModelMap() {
  if (_openclawModelMapCache !== null) return _openclawModelMapCache;
  try {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) { _openclawModelMapCache = new Map(); return _openclawModelMapCache; }
    const cfgPath = process.env.OPENCLAW_CONFIG || `${home}/.openclaw/openclaw.json`;
    if (!existsSync(cfgPath)) { _openclawModelMapCache = new Map(); return _openclawModelMapCache; }
    const raw = readFileSync(cfgPath, "utf8");
    const cfg = JSON.parse(raw);
    const map = new Map();
    const agentsSection = cfg.agents;
    if (agentsSection && typeof agentsSection === "object") {
      const list = Array.isArray(agentsSection.list) ? agentsSection.list : [];
      for (const a of list) {
        if (!a || typeof a !== "object") continue;
        const id = a.id || a.name;
        if (!id) continue;
        const m = a.model;
        if (typeof m === "string") map.set(String(id), m);
        else if (m && typeof m === "object" && typeof m.primary === "string") map.set(String(id), m.primary);
      }
    }
    _openclawModelMapCache = map;
    if (map.size > 0) {
      console.log(`[ap-client] Layer 1.5: loaded ${map.size} per-agent default model(s) from ${cfgPath}`);
    }
    return map;
  } catch (err) {
    console.warn(`[ap-client] Layer 1.5 openclaw.json read failed: ${err && err.message ? err.message : err}`);
    _openclawModelMapCache = new Map();
    return _openclawModelMapCache;
  }
}

function resolveModelTag(agent) {
  // Explicit AP_MODEL env wins for emergency overrides (debugging, testing).
  if (GLOBAL_MODEL) return { model: GLOBAL_MODEL, attested: false };
  // Brain override from ap-client.json is the normal path.
  const brain = agent && agent.brain ? agent.brain : null;
  if (brain && BRAIN_TO_MODEL[brain]) return BRAIN_TO_MODEL[brain];
  // Fallback 1: whatever the backend reported at bootstrap (openclaw default).
  if (agent && agent.model) return { model: agent.model, attested: false };
  // Fallback 2 (Layer 1.5): per-agent model.primary from openclaw.json,
  // looked up by the OpenClaw agent slug (not the display name).
  if (agent && agent.openclawAgent) {
    const map = _loadOpenclawModelMap();
    const m = map.get(agent.openclawAgent);
    if (m) return { model: m, attested: false };
  }
  // Unknown — honest null.
  return { model: null, attested: false };
}

// Set to "0" (or any falsy value) to keep using long-lived apt_ tokens.
// Default: exchange apt_ for a short-lived aps_/apr_ session pair at startup,
// auto-refresh before expiry, auto-reissue from apt_ on session death.
const USE_SESSIONS = process.env.AP_USE_SESSIONS !== "0";

// Comma-separated list of agent NAMES that should have the TOOL_CALL loop
// enabled. Use "*" to enable for all bootstrapped agents. Example:
//   AP_TOOLS_ENABLED="Passport Police,UX Agent"
// Legacy-config agents can also set `"tools": true` directly in their block.
const TOOLS_ENABLED_ENV = (process.env.AP_TOOLS_ENABLED || "").trim();
const TOOLS_ENABLED_SET = TOOLS_ENABLED_ENV === "*"
  ? "*"
  : new Set(TOOLS_ENABLED_ENV.split(",").map(s => s.trim()).filter(Boolean));
function shouldEnableTools(agent) {
  if (agent.tools === true) return true;        // explicit per-agent override wins
  if (agent.tools === false) return false;
  if (TOOLS_ENABLED_SET === "*") return true;
  return TOOLS_ENABLED_SET.has(agent.name);
}

// Refresh the access token when it has fewer than this many seconds left.
const REFRESH_SKEW_SEC = 5 * 60; // 5 minutes

// ── Keychain helpers (macOS /usr/bin/security, no npm deps) ─────────────────
// We shell out rather than binding to a native lib so launchd daemons don't
// need a rebuild per Node version and dev-on-Linux stays trivial.
function execFileP(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs || 5000 }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || "", stderr: stderr || "" });
    });
  });
}
async function keychainGet(account) {
  if (!USE_KEYCHAIN) return null;
  const { err, stdout } = await execFileP("/usr/bin/security", [
    "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w",
  ]);
  if (err) return null;
  return stdout.trim() || null;
}
async function keychainSet(account, value) {
  if (!USE_KEYCHAIN) return false;
  // -U = "update if exists". First try updating in place.
  const first = await execFileP("/usr/bin/security", [
    "add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", value,
  ]);
  if (!first.err) return true;
  // Observed on macOS 14+: -U occasionally surfaces "already exists" anyway
  // (SecKeychainItemCreateFromContent). Fall back to delete-then-add.
  // ensureAccessToken is serialized per agent so we don't race with ourselves.
  await execFileP("/usr/bin/security", [
    "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account,
  ]);
  const second = await execFileP("/usr/bin/security", [
    "add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", value,
  ]);
  if (second.err) {
    console.warn(`[keychain] set ${account.slice(0, 18)}… failed after retry: ${(second.stderr || second.err.message).slice(0, 160)}`);
    return false;
  }
  return true;
}
async function keychainDelete(account) {
  if (!USE_KEYCHAIN) return false;
  // delete errors if item doesn't exist — expected, silently succeed
  await execFileP("/usr/bin/security", [
    "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account,
  ]);
  return true;
}

// ── Persisted session cache ─────────────────────────────────────────────────
// Surviving bridge restarts means we don't burn an apt_→aps_ exchange on
// every launchd kickstart. Keyed by passportId so apt_ rotation doesn't
// orphan the cache. Keychain-first on macOS; 0600 file fallback elsewhere.
function aptKey(apt) {
  // Retained for logging only. Not used as a store key in Track 2.
  return createHash("sha256").update(apt).digest("hex").slice(0, 16);
}
function passportKey(passportId) {
  // Stable keychain account. Hashed so the DID isn't visible in Security.app
  // screenshots; prefixed so it's easy to grep in `security dump-keychain`.
  return "sess-" + createHash("sha256").update(String(passportId)).digest("hex").slice(0, 24);
}
// Bootstrap secret slots in the OS keychain. Item #12 (SWOT, 2026-04-19):
// lets operators install the bridge without ever writing apt_/aptr_ to disk.
// Same hashing scheme as passportKey so the three slots (sess, apt, aptr)
// are easy to spot side-by-side in `security dump-keychain`.
function aptKeyFor(passportId) {
  return "apt-" + createHash("sha256").update(String(passportId)).digest("hex").slice(0, 24);
}
function aptrKeyFor(passportId) {
  return "aptr-" + createHash("sha256").update(String(passportId)).digest("hex").slice(0, 24);
}
// Recall a stashed apt_ (+ optional aptr_) for a passport. Returns null
// when either keychain is disabled (non-macOS, AP_KEYCHAIN=0) or nothing
// is stashed for this DID.
async function keychainRecallApt(passportId) {
  if (!USE_KEYCHAIN) return null;
  const apt = await keychainGet(aptKeyFor(passportId));
  if (!apt) return null;
  const aptr = await keychainGet(aptrKeyFor(passportId));
  return { apt, aptr: aptr || null };
}
// Stash an apt_ (+ optional aptr_) for a passport. Returns true only when
// the primary apt_ write succeeded. Used by the brainclaw CLI on fresh
// install to bypass the plaintext ap-client.json step.
async function keychainStashApt(passportId, apt, aptr) {
  if (!USE_KEYCHAIN) return false;
  if (!apt || typeof apt !== "string" || !apt.startsWith("apt_")) return false;
  const ok = await keychainSet(aptKeyFor(passportId), apt);
  if (!ok) return false;
  if (aptr && typeof aptr === "string" && aptr.startsWith("aptr_")) {
    await keychainSet(aptrKeyFor(passportId), aptr);
  }
  return true;
}
// Burn any stashed bootstrap secrets for this passport. Called after
// successful apt_ → aps_/apr_ exchange so the same secret never sits in
// two stores simultaneously.
async function keychainPurgeApt(passportId) {
  if (!USE_KEYCHAIN) return;
  await keychainDelete(aptKeyFor(passportId));
  await keychainDelete(aptrKeyFor(passportId));
}
function loadFileStore() {
  try { return JSON.parse(readFileSync(SESSION_STORE, "utf8")); }
  catch { return {}; }
}
function saveFileStore(store) {
  try {
    writeFileSync(SESSION_STORE, JSON.stringify(store, null, 2));
    try { chmodSync(SESSION_STORE, 0o600); } catch {}
  } catch (err) {
    console.warn(`[session-store] file save failed: ${err.message}`);
  }
}
async function rememberSession(agent, session) {
  if (!agent || !agent.passportId) return;
  const key = passportKey(agent.passportId);
  const payload = {
    sessionId: session.sessionId,
    accessToken: session.accessToken,
    accessExpiresAt: session.accessExpiresAt,
    refreshToken: session.refreshToken,
    refreshExpiresAt: session.refreshExpiresAt,
  };
  if (USE_KEYCHAIN) {
    const ok = await keychainSet(key, JSON.stringify(payload));
    if (ok) return;
    // Keychain refused — fall through to file so bridge still works.
  }
  const store = loadFileStore();
  store[key] = payload;
  saveFileStore(store);
}
async function forgetSession(agent) {
  if (!agent || !agent.passportId) return;
  const key = passportKey(agent.passportId);
  if (USE_KEYCHAIN) await keychainDelete(key);
  const store = loadFileStore();
  if (store[key]) { delete store[key]; saveFileStore(store); }
}
async function recallSession(agent) {
  if (!agent || !agent.passportId) return null;
  const key = passportKey(agent.passportId);
  let s = null;
  if (USE_KEYCHAIN) {
    const raw = await keychainGet(key);
    if (raw) {
      try { s = JSON.parse(raw); } catch { s = null; }
    }
  }
  if (!s) {
    // Fall back to file store — covers non-macOS and any pre-migration
    // entries that haven't moved to keychain yet.
    const store = loadFileStore();
    s = store[key] || null;
  }
  if (!s) return null;
  // Don't hand back sessions whose refresh has already expired — saves a
  // wasted refresh attempt on boot.
  const refreshMs = s.refreshExpiresAt ? new Date(s.refreshExpiresAt).getTime() : 0;
  if (refreshMs && refreshMs - Date.now() < 60_000) return null;
  return s;
}

// ── Bootstrap-secrets purge (Track 2) ───────────────────────────────────────
// After the first apt_ → aps_/apr_ exchange succeeds and the session is in
// keychain, null out the apt_ + aptr_ in ap-client.json. Police's 2026-04-18
// success criteria: "the bridge never stores apt_ or a creator JWT again".
// Keeps passportId + label in the file so the bridge can rehydrate from
// keychain on next restart without another bootstrap.
async function purgeBootstrapSecrets(agent) {
  if (agent._secretsPurged) return; // one-shot per process
  try {
    const raw = readFileSync(CONFIG_FILE, "utf8");
    const cfg = JSON.parse(raw);
    let mutated = false;
    if (Array.isArray(cfg.tokenPairs)) {
      for (const pair of cfg.tokenPairs) {
        if (!pair) continue;
        const match = (pair.passportId && pair.passportId === agent.passportId) ||
                      (pair.apt && pair.apt === agent.token);
        if (!match) continue;
        if (pair.apt) { pair.apt = null; mutated = true; }
        if (pair.aptr) { pair.aptr = null; mutated = true; }
        if (!pair.passportId) pair.passportId = agent.passportId;
        pair.purgedAt = new Date().toISOString();
        pair.migration = "track-2:keychain";
      }
    }
    if (Array.isArray(cfg.tokens)) {
      const idx = cfg.tokens.indexOf(agent.token);
      if (idx !== -1) { cfg.tokens[idx] = null; mutated = true; }
    }
    if (!mutated) {
      agent._secretsPurged = true;
      return;
    }
    const tmp = `${CONFIG_FILE}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
    try { chmodSync(tmp, 0o600); } catch {}
    const { renameSync } = await import("fs");
    renameSync(tmp, CONFIG_FILE);
    console.log(`[${agent.name}] 🔐 bootstrap secrets purged from disk (apt_/aptr_ → null, session in ${USE_KEYCHAIN ? "Keychain" : "file"})`);
    // Clear in-memory secrets too. From here on the bridge runs on aps_/apr_
    // only — no fallback to apt_-issued sessions even if disk is tampered.
    agent.token = null;
    agent.rotateToken = null;
    agent._secretsPurged = true;
  } catch (err) {
    console.warn(`[${agent.name}] bootstrap purge skipped: ${err.message}`);
  }
}

// ── Session management ──────────────────────────────────────────────────────
// Exchange a long-lived apt_ for an access + refresh pair.
// Returns { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt, sessionId } or null.
async function issueSessionFromApt(apt, deviceLabel) {
  try {
    const res = await fetch(`${VPS_HTTP}/agent/session/issue`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apt}`, "Content-Type": "application/json" },
      body: JSON.stringify({ deviceLabel: deviceLabel || "ap-client bridge" }),
    });
    if (!res.ok) {
      console.error(`[session] issue failed HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`[session] issue error: ${err.message}`);
    return null;
  }
}

// Rotate a refresh token. Single-use: old apr_ is burned server-side.
// Returns same shape as issue, or null on any failure. If null, caller should
// fall back to re-issuing from apt_.
async function refreshSession(refreshToken) {
  try {
    const res = await fetch(`${VPS_HTTP}/agent/session/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) {
      console.error(`[session] refresh failed HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.error(`[session] refresh error: ${err.message}`);
    return null;
  }
}

// Ensure agent.accessToken is valid and not close to expiring.
// Order of attempts: still-valid → refresh → re-issue-from-apt (pre-migration
// only). Track 2: once apt_ is purged from disk, re-issue is impossible and
// a dead apr_ requires manual re-bootstrap — that's the security gate.
//
// Serialized per agent: two parallel callers (e.g. agent-in-2-rooms connecting
// concurrently) share a single in-flight promise. Without this we'd burn two
// issueSessionFromApt roundtrips + race on keychainSet.
async function ensureAccessToken(agent) {
  if (!USE_SESSIONS) return agent.token; // legacy path: use apt_ directly
  if (agent._ensurePending) return agent._ensurePending;
  const p = _ensureAccessTokenInner(agent).finally(() => { agent._ensurePending = null; });
  agent._ensurePending = p;
  return p;
}
async function _ensureAccessTokenInner(agent) {
  // First call for this agent after a bridge restart: hydrate from keychain
  // (or file fallback) so we don't burn a fresh apt_→aps_ exchange on every
  // launchd kickstart.
  if (!agent._hydrated) {
    const cached = await recallSession(agent);
    if (cached) {
      agent.accessToken = cached.accessToken;
      agent.accessExpiresAt = cached.accessExpiresAt;
      agent.refreshToken = cached.refreshToken;
      agent.refreshExpiresAt = cached.refreshExpiresAt;
      agent.sessionId = cached.sessionId;
      console.log(`[${agent.name}] session hydrated from ${USE_KEYCHAIN ? "keychain" : "file"} (sid=${cached.sessionId.slice(-8)})`);
    }
    agent._hydrated = true;
  }

  const now = Date.now();
  const expiresMs = agent.accessExpiresAt ? new Date(agent.accessExpiresAt).getTime() : 0;
  if (agent.accessToken && (expiresMs - now) > REFRESH_SKEW_SEC * 1000) {
    return agent.accessToken;
  }

  if (agent.refreshToken) {
    const refreshed = await refreshSession(agent.refreshToken);
    if (refreshed) {
      agent.accessToken = refreshed.accessToken;
      agent.accessExpiresAt = refreshed.accessExpiresAt;
      agent.refreshToken = refreshed.refreshToken;
      agent.refreshExpiresAt = refreshed.refreshExpiresAt;
      agent.sessionId = refreshed.sessionId;
      await rememberSession(agent, refreshed);
      console.log(`[${agent.name}] session refreshed (new sid=${refreshed.sessionId.slice(-8)})`);
      return agent.accessToken;
    }
    console.warn(`[${agent.name}] session refresh failed — dropping cached session`);
    await forgetSession(agent);
    agent.refreshToken = null;
    agent.refreshExpiresAt = null;
  }

  // No live session. If we still have apt_ on disk (pre-migration, or first
  // run after a re-bootstrap), exchange it. Otherwise try keychain-stashed
  // apt_ (Track-2 recovery), then the bridge must be manually re-bootstrapped
  // — that's Police's security gate.
  if (!agent.token || !agent.token.startsWith("apt_")) {
    // Track-2 recovery: apt_/aptr_ were purged from disk but stashed in
    // keychain under apt-<hash> / aptr-<hash>. Pull them back before
    // declaring re-bootstrap required.
    const stashed = await keychainRecallApt(agent.passportId);
    if (stashed?.apt) {
      console.log(`[${agent.name}] apt_ recalled from keychain (Track-2 recovery path)`);
      agent.token = stashed.apt;
      if (stashed.aptr) agent.rotateToken = stashed.aptr;
    }
  }
  if (!agent.token || !agent.token.startsWith("apt_")) {
    console.error(`[${agent.name}] no apr_ in keychain and no apt_ on disk — re-bootstrap required`);
    return null;
  }

  const issued = await issueSessionFromApt(agent.token, `ap-client — ${agent.name}`);
  if (!issued) {
    console.error(`[${agent.name}] could not issue session — falling back to apt_ for this call`);
    return agent.token;
  }
  agent.accessToken = issued.accessToken;
  agent.accessExpiresAt = issued.accessExpiresAt;
  agent.refreshToken = issued.refreshToken;
  agent.refreshExpiresAt = issued.refreshExpiresAt;
  agent.sessionId = issued.sessionId;
  await rememberSession(agent, issued);
  console.log(`[${agent.name}] new session issued (sid=${issued.sessionId.slice(-8)}, aps TTL ${Math.round((new Date(issued.accessExpiresAt).getTime() - Date.now()) / 60000)}m)`);
  // Track 2: stash apt_ + aptr_ in keychain FIRST, then nuke from disk. If
  // the stash fails we leave the disk copy alone — Mini's 2026-04-20 strand
  // happened because this stash call never existed and purge still ran.
  const stashOk = await keychainStashApt(agent.passportId, agent.token, agent.rotateToken);
  if (stashOk) {
    await purgeBootstrapSecrets(agent);
  } else {
    console.warn(`[${agent.name}] keychain stash of apt_/aptr_ failed — leaving secrets on disk (no purge)`);
  }
  return agent.accessToken;
}

// ── Auto-rotate apt_ via aptr_ scoped token (Anti-clone T1.5) ───────────────
// Police's veto (2026-04-18): creator JWT on the bridge is too much power.
// Fix: each paired agent holds a least-privilege `aptr_` that can ONLY call
// POST /passports/:id/regenerate-token for its own passport. Bridge polls
// /passports/:id/token-ttl and rotates before expiry. If the aptr_ leaks,
// blast radius = one passport's rotation cadence.
const AUTO_ROTATE_POLL_MS = parseInt(process.env.AP_AUTO_ROTATE_POLL_MS || String(6 * 3600_000), 10); // 6h
const AUTO_ROTATE_STARTUP_DELAY_MS = 30_000; // wait 30s after boot before first check

async function pollTokenTtl(agent, host) {
  try {
    // Nginx strips /api/ and forwards /passports/... to backend. Direct-to-3100
    // dev skips the /api prefix; in that case set AP_HTTP=http://host:3100.
    const base = host.includes(":3100") ? host : `${host}/api`;
    const res = await fetch(`${base}/passports/${agent.passportId}/token-ttl`, {
      headers: { "Authorization": `Bearer ${agent.token}` },
    });
    if (!res.ok) {
      console.warn(`[${agent.name}] token-ttl probe HTTP ${res.status}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[${agent.name}] token-ttl probe error: ${err.message}`);
    return null;
  }
}

async function rotateAptViaAptr(agent, host) {
  if (!agent.rotateToken) {
    console.warn(`[${agent.name}] rotate skipped: no aptr_ configured`);
    return false;
  }
  try {
    const base = host.includes(":3100") ? host : `${host}/api`;
    const res = await fetch(`${base}/passports/${agent.passportId}/regenerate-token`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${agent.rotateToken}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[${agent.name}] rotate failed HTTP ${res.status}: ${body.slice(0, 200)}`);
      return false;
    }
    const data = await res.json();
    // regenerate-token returns { success, apiToken, apiTokenExpiresAt, ... }
    const newApt = data.apiToken || data.token || data.apt;
    const newExpiresAt = data.apiTokenExpiresAt || data.expiresAt;
    if (!newApt || !newApt.startsWith("apt_")) {
      console.error(`[${agent.name}] rotate response missing apt_`);
      return false;
    }
    const oldApt = agent.token;
    agent.token = newApt;
    // Track 2: sessions are keyed by passportId (not apt_), so apt_ rotation
    // does NOT orphan the cached aps_/apr_. We intentionally DON'T call
    // forgetSession() here — the existing aps_ is a passport-scoped token
    // that survives its originating apt_'s rotation. If the server revokes
    // sessions on apt_ rotation (it shouldn't, but if policy changes), the
    // next postReply 401 retry will refresh naturally.
    // Persist the apt_ swap in ap-client.json atomically.
    await swapAptInConfig(oldApt, newApt);
    const mask = (t) => `${t.slice(0, 8)}...${t.slice(-4)}`;
    console.log(`[${agent.name}] 🔄 apt_ rotated: ${mask(oldApt)} → ${mask(newApt)} (expires ${newExpiresAt || "?"})`);
    return true;
  } catch (err) {
    console.error(`[${agent.name}] rotate error: ${err.message}`);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Round 22 follow-up (brain-room R22 vote 3/3 unanimous Maat + Blanco +
// UX Agent, 2026-05-04): auto-call POST /agent/declare on bridge startup
// so the covenant agent signature lands seconds after the bridge is
// authenticated, not whenever the operator gets around to opening the
// dashboard. Kills the amber "agent signature pending" state on /verify
// for new mints.
//
// Maat's constraint: model/disclosure values must come from the agent's
// own identity source — NOT arbitrary placeholders. We honor this by:
//   1. Reading openclaw's local AGENT.md if present (operator's authored
//      identity for that agent) and using its first sentence as the
//      transparency disclosure if it's substantive (≥20 chars, not just
//      "# AgentName").
//   2. Falling back to a non-placeholder default that names the bridge
//      identity: "<agentName>: PrMaat agent running via OpenClaw bridge
//      on operator's machine; local-model brain, no remote LLM calls."
//      That's honest about what the bridge actually IS — it qualifies
//      as a real disclosure under spec §2.4.
//
// Idempotent: we read /api/passports/<id>/did.json first; if
// prmaat:covenant_agent_signed_at is already populated, we skip. So
// re-running the bridge doesn't spam declare events.
async function ensureAgentDeclared(agent, hostOverride) {
  const host = hostOverride || VPS_HTTP;
  const passportId = agent.passportId || agent.did;
  if (!passportId || !passportId.startsWith("did:")) return;
  // 1. Idempotency check: only fire once per passport. Read the public
  //    DID Document (no auth required for did.json on prmaat.com).
  let alreadySigned = false;
  try {
    const url = `${host}/api/passports/${encodeURIComponent(passportId)}/did.json`;
    const res = await fetch(url, { headers: { "Accept": "application/did+json" } });
    if (res.ok) {
      const doc = await res.json();
      const agentSignedAt = doc["prmaat:covenant_agent_signed_at"];
      if (agentSignedAt) {
        alreadySigned = true;
      }
    }
  } catch {
    // Network blip on did.json — proceed to declare anyway (idempotent
    // server-side: a second call just no-ops the covenant flip).
  }
  if (alreadySigned) {
    console.log(`[${agent.name}] covenant agent-signature already on record — skipping auto-declare`);
    return;
  }
  // 2. Build disclosure from local AGENT.md if available, else honest
  //    default. Maat's rule: source from agent's own identity, not
  //    arbitrary placeholder. Round 22 wave 2 (Maat + UX Agent
  //    converged 2/4): also track WHICH path produced the disclosure
  //    so the server can record source provenance in the audit chain
  //    and verifiers can distinguish identity-file-derived from
  //    bridge-default fallback.
  const openclawAgent = agent.openclawAgent || agent.name;
  const agentMdPath = `${homedir()}/.openclaw/agents/${openclawAgent}/agent/AGENT.md`;
  let disclosure = "";
  let disclosureSource = ""; // "agent-md" if read from AGENT.md, else "bridge-default"
  try {
    const md = readFileSync(agentMdPath, "utf-8");
    // Strip leading markdown heading "# Foo" so we don't return just
    // the agent name. Take the first non-blank, non-heading paragraph.
    const lines = md.split("\n").map((l) => l.trim());
    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith("#")) continue;
      // First substantive line = disclosure candidate. Strip markdown.
      const stripped = line.replace(/[*_`]+/g, "").replace(/<[^>]+>/g, "").trim();
      if (stripped.length >= 20) {
        disclosure = stripped.slice(0, 480); // leave headroom under 500-char cap
        disclosureSource = "agent-md";
        break;
      }
    }
  } catch {
    // No AGENT.md — fall through to default.
  }
  if (!disclosure) {
    disclosure = `${agent.name}: PrMaat agent running via OpenClaw bridge on operator's machine; local-model brain, no remote LLM calls.`;
    disclosureSource = "bridge-default";
  }
  // 3. POST /agent/declare with the sourced disclosure. The server will:
  //    (a) replace the bridge-pending placeholder, flipping
  //        disclosure_pending = false (R21 rule)
  //    (b) record the agent's covenant signature, flipping
  //        covenantAgentSignedAt to now (R22 rule)
  //    (c) emit signed passport.declared + passport.covenant_signed
  //        events into the daily Merkle root
  try {
    const token = await ensureAccessToken(agent);
    if (!token) {
      console.warn(`[${agent.name}] auto-declare skipped: no access token`);
      return;
    }
    const url = `${host}/agent/declare`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        transparencyDisclosure: disclosure,
        disclosureSource, // "agent-md" or "bridge-default" — Round 22 wave 2
        // riskLevel + agentType intentionally omitted: operator may set
        // these on dashboard, and the bridge has no honest source for them
        // beyond a placeholder. R21 rule: declare what we know, don't
        // fabricate. The covenant signature still fires off the disclosure
        // alone.
      }),
    });
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      const cov = body.covenantAgentSigned;
      if (cov) {
        console.log(`[${agent.name}] ✓ auto-declared: covenant ${cov.version || "v0.1"} agent-signed @ ${cov.signedAt}`);
      } else {
        console.log(`[${agent.name}] ✓ auto-declared (covenant signature not surfaced — likely already on record)`);
      }
    } else {
      const errText = await res.text().catch(() => "");
      // Common case: bridge restart on a passport that was already
      // declared by an earlier run. Server returns 400 EMPTY_DECLARATION
      // if disclosure happens to match; we treat any non-2xx as benign.
      console.warn(`[${agent.name}] auto-declare returned ${res.status}: ${_scrubTokens(errText).slice(0, 200)}`);
    }
  } catch (err) {
    console.warn(`[${agent.name}] auto-declare failed: ${err && err.message ? err.message : err}`);
  }
}

function startAutoRotate(agent, hostOverride) {
  if (!agent.rotateToken) return; // only pairs with aptr_ get auto-rotate
  const host = hostOverride || VPS_HTTP;
  const tick = async () => {
    // Track 2: after purgeBootstrapSecrets runs, agent.token is null and
    // there's nothing to rotate. Session refresh handles liveness now.
    if (!agent.token || !agent.token.startsWith("apt_")) return;
    if (!agent.rotateToken) return;
    const ttl = await pollTokenTtl(agent, host);
    if (!ttl || !ttl.ok) return;
    if (ttl.expired) {
      // apt_ already dead — try rotate anyway, might recover
      console.warn(`[${agent.name}] apt_ expired at ${ttl.expiresAt} — attempting emergency rotate`);
      await rotateAptViaAptr(agent, host);
      return;
    }
    if (ttl.rotateSoon) {
      console.log(`[${agent.name}] auto-rotate: ${ttl.expiresInSeconds}s left → rotating via aptr_`);
      await rotateAptViaAptr(agent, host);
    }
  };
  // Initial delayed tick + steady cadence.
  setTimeout(tick, AUTO_ROTATE_STARTUP_DELAY_MS);
  setInterval(tick, AUTO_ROTATE_POLL_MS);
  console.log(`[${agent.name}] auto-rotate enabled (polling ${Math.round(AUTO_ROTATE_POLL_MS / 60_000)}min)`);
}

// ── Presence heartbeat ──────────────────────────────────────────────────────
// The bridge is HTTP-only. The server only stamps room_members.last_seen_at
// on WS-drop (src/ws/manager.ts#stampLastSeen), so without a WS our agents
// are invisible to the 3-state presence UI (see migration
// 20260418_presence_last_seen.sql — Offline unless lastSeenAt is fresh).
// Every ~60s we POST /api/rooms/:id/heartbeat which bumps the column. A
// failed pulse is non-fatal: the next tick retries, and token issues are
// already handled by ensureAccessToken / the auto-rotate plumbing.
const HEARTBEAT_POLL_MS = parseInt(process.env.AP_HEARTBEAT_POLL_MS || "60000", 10);
const HEARTBEAT_STARTUP_DELAY_MS = 5_000;

async function sendHeartbeat(agent, roomId, host) {
  const token = await ensureAccessToken(agent);
  if (!token) return;
  const base = host.includes(":3100") ? host : `${host}/api`;
  try {
    const res = await fetch(`${base}/rooms/${roomId}/heartbeat`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (!res.ok) {
      console.warn(`[${agent.name}] heartbeat ${roomId.slice(0, 10)} HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`[${agent.name}] heartbeat ${roomId.slice(0, 10)} error: ${err.message}`);
  }
}

function startHeartbeat(agent, roomId, hostOverride) {
  const host = hostOverride || VPS_HTTP;
  setTimeout(() => sendHeartbeat(agent, roomId, host), HEARTBEAT_STARTUP_DELAY_MS);
  setInterval(() => sendHeartbeat(agent, roomId, host), HEARTBEAT_POLL_MS);
}

// ── Mention poll — HTTP fallback for WS outages ─────────────────────────────
// The real-time mention path is WS `mention.notify` (see connectAgentRoom).
// When the WS is healthy, mentions flow in immediately and this loop is
// redundant. When the WS is NOT healthy — auth circuit tripped, long
// network flap, reconnect loop — mentions are silently dropped once they
// age past the server's 5-min `mention.catchup` replay window.
//
// This belt-and-suspenders HTTP poll closes that gap. Every ~45s we call
// GET /rooms/:id/messages?mentionsMe=true&since=<last> and feed any new
// rows into handleMention. The loop-guard `markHandled(messageId)` inside
// handleMention dedupes against the WS path, so a mention arriving on BOTH
// channels is processed exactly once.
//
// Initial `since` is 10 min ago so a bridge restart during a real outage
// still replays the gap. Subsequent ticks use the server's `nextSince`
// pagination cursor to advance the window monotonically.
//
// Off-phase from heartbeat (45s vs 60s) to avoid request pile-up on the
// same tick. Cadence is configurable via AP_MENTION_POLL_MS.
const MENTION_POLL_MS = parseInt(process.env.AP_MENTION_POLL_MS || "45000", 10);
const MENTION_POLL_STARTUP_DELAY_MS = 8_000;
const MENTION_POLL_INITIAL_LOOKBACK_MS = 10 * 60 * 1000;

// Round 22 wave 9g (v0.3.7, brain-room 4/4 unanimous 2026-05-05): track
// mention-poll intervals so we can stop them when the server returns
// X-Stop-Polling: true on a non-member 403. Without this, a bridge
// configured with `rooms: "all"` polls every room for every agent —
// non-member (passport × room) pairs loop on the same `since` cursor
// forever, getting 403 every cycle. The audit caught 723 × 403 in
// 6h on one room from this bug.
//
// Map key: `${agentName}|${roomId}` (agent names are unique per bridge
// instance per memory). Value: { intervalId, blockedReason? }.
const mentionPollHandles = new Map();

function mentionPollKey(agent, roomId) { return `${agent.name}|${roomId}`; }

async function pollMentions(agent, roomId, host, state) {
  const token = await ensureAccessToken(agent);
  if (!token) return;
  const base = host.includes(":3100") ? host : `${host}/api`;
  const sinceParam = state.since ? `&since=${encodeURIComponent(state.since)}` : "";
  try {
    const res = await fetch(
      `${base}/rooms/${roomId}/messages?mentionsMe=true${sinceParam}&limit=25`,
      { headers: { "Authorization": `Bearer ${token}` } },
    );
    if (!res.ok) {
      // Round 22 wave 9g: server hint says "stop polling this pair."
      // Per Police's R22 vote: only honor on authenticated HTTPS from
      // the configured API origin (we already only call VPS_HTTP / host)
      // AND when the body says NOT_A_MEMBER (verified below). The 403
      // is authoritative regardless; this just stops the bandwidth waste.
      if (res.status === 403 && res.headers.get("x-stop-polling") === "true") {
        let bodyCode = null;
        try {
          const body = await res.json();
          bodyCode = body?.code;
        } catch { /* body parse failed; treat as ordinary 403 */ }
        if (bodyCode === "NOT_A_MEMBER") {
          const key = mentionPollKey(agent, roomId);
          const handle = mentionPollHandles.get(key);
          if (handle?.intervalId) clearInterval(handle.intervalId);
          mentionPollHandles.set(key, { intervalId: null, blockedReason: "NOT_A_MEMBER" });
          // Single warning per drop. Reset on reconnect (resetMentionPollBlocks).
          console.warn(`[${agent.name}] mention-poll ${roomId.slice(0, 10)} stopped: NOT_A_MEMBER (server X-Stop-Polling hint honored)`);
          return;
        }
      }
      // 404/410 (room closed) is a normal terminal state — no need to spam logs.
      if (res.status !== 404 && res.status !== 410) {
        console.warn(`[${agent.name}] mention-poll ${roomId.slice(0, 10)} HTTP ${res.status}`);
      }
      return;
    }
    const data = await res.json();
    // Advance the cursor unconditionally so a quiet room doesn't keep scanning
    // the same 10-min window forever. nextSince mirrors the server's view of
    // "last message I've told you about."
    if (data.nextSince) state.since = data.nextSince;
    const messages = Array.isArray(data.messages) ? data.messages : [];
    for (const m of messages) {
      // Defensive: never process our own messages (can't self-mention, but
      // mention.notify parity — WS path skips these too).
      if (m.passportId === agent.passportId) continue;
      // Synthesize a mention.notify-shaped event. `context` is empty here
      // (the WS payload supplies server-rendered context via
      // src/services/mentionResponder.ts); handleMention will prompt without
      // it. That's a minor degradation vs the WS path, not a bug — the
      // OpenClaw brain still has the mention text and the room language rule.
      await handleMention(agent, roomId, {
        messageId: m.id,
        senderPassportId: m.passportId,
        mentionedPassportId: agent.passportId,
        content: m.content,
        context: "",
        roomLanguage: m.roomLanguage || null,
        broadcastMode: false,
      });
    }
  } catch (err) {
    console.warn(`[${agent.name}] mention-poll ${roomId.slice(0, 10)} error: ${err.message}`);
  }
}

function startMentionPoll(agent, roomId, hostOverride) {
  const host = hostOverride || VPS_HTTP;
  const key = mentionPollKey(agent, roomId);

  // Round 22 wave 9g: if this (agent × room) is blocked from a
  // previous NOT_A_MEMBER hint, don't restart the poll. resetMentionPollBlocks()
  // (called on bridge reconnect / membership refresh) clears the block.
  const existing = mentionPollHandles.get(key);
  if (existing?.blockedReason) return;
  if (existing?.intervalId) clearInterval(existing.intervalId);

  const state = { since: new Date(Date.now() - MENTION_POLL_INITIAL_LOOKBACK_MS).toISOString() };
  setTimeout(() => pollMentions(agent, roomId, host, state), MENTION_POLL_STARTUP_DELAY_MS);
  const intervalId = setInterval(() => pollMentions(agent, roomId, host, state), MENTION_POLL_MS);
  mentionPollHandles.set(key, { intervalId, blockedReason: null });
}

// Round 22 wave 9g: clear the (agent × room) block list. Called when a
// bridge reconnects (membership may have changed: agent newly added /
// removed from a room) so we re-attempt polls fresh.
function resetMentionPollBlocks() {
  let cleared = 0;
  for (const [key, h] of mentionPollHandles.entries()) {
    if (h.blockedReason) {
      mentionPollHandles.delete(key);
      cleared++;
    }
  }
  if (cleared > 0) {
    console.log(`[bridge] mention-poll blocks cleared (${cleared} pairs); will re-attempt on next room subscription.`);
  }
}

// ── Config ───────────────────────────────────────────────────────────────────
// ap-client.json formats:
//   Legacy (still supported):
//     { "tokens": ["apt_xxx", "apt_yyy"] }
//   Anti-clone T1.5 (auto-rotate-capable):
//     { "tokenPairs": [ { "apt": "apt_xxx", "aptr": "aptr_yyy" }, ... ] }
//   Fully inline (legacy per-agent):
//     { "agents": [ { "name": "...", "token": "apt_...", "rooms": [...], ... } ] }
//
// When a tokenPair has an aptr_, the bridge polls /passports/:id/token-ttl and
// uses the aptr_ to mint a fresh apt_ via /regenerate-token before the current
// apt_ expires. Police's Track 1.5 architecture: blast radius of a pwned
// bridge is one passport's rotation cadence, not the creator account.
function loadConfig() {
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf8")); }
  catch (e) {
    console.error(`[ap-client] Failed to load ${CONFIG_FILE}:`, e.message);
    process.exit(1);
  }
}

// ── Atomic config write (T1.5) ───────────────────────────────────────────────
// Serialize writes so simultaneous rotations across agents don't race on the
// same file. Reads the current file fresh each time (preserves fields we
// don't touch, like comments-as-keys or future schema additions) and swaps
// the matching apt_ in tokenPairs.
let _cfgWriteLock = Promise.resolve();
async function swapAptInConfig(oldApt, newApt) {
  const next = async () => {
    try {
      const raw = readFileSync(CONFIG_FILE, "utf8");
      const cfg = JSON.parse(raw);
      let mutated = false;

      if (Array.isArray(cfg.tokenPairs)) {
        for (const pair of cfg.tokenPairs) {
          if (pair && pair.apt === oldApt) {
            pair.apt = newApt;
            pair.rotatedAt = new Date().toISOString();
            mutated = true;
          }
        }
      }
      // Also swap legacy flat tokens list if someone paired them manually.
      if (Array.isArray(cfg.tokens)) {
        const idx = cfg.tokens.indexOf(oldApt);
        if (idx !== -1) { cfg.tokens[idx] = newApt; mutated = true; }
      }

      if (!mutated) {
        console.warn(`[auto-rotate] config swap: old apt_ not found in ${CONFIG_FILE} — token updated in memory only`);
        return;
      }

      // Atomic: write tmp → rename. rename(2) is atomic on same filesystem.
      const tmp = `${CONFIG_FILE}.tmp.${process.pid}.${Date.now()}`;
      writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
      try { chmodSync(tmp, 0o600); } catch {}
      // fs.renameSync via built-in — import alias
      const { renameSync } = await import("fs");
      renameSync(tmp, CONFIG_FILE);
    } catch (err) {
      console.error(`[auto-rotate] config swap failed: ${err.message}`);
    }
  };
  _cfgWriteLock = _cfgWriteLock.then(next, next);
  return _cfgWriteLock;
}

// ── Deduplication: remember message IDs we already handled ──────────────────
const handled = new Set();
const HANDLED_MAX = 500;
function markHandled(id) {
  if (!id) return false;
  if (handled.has(id)) return false;
  handled.add(id);
  if (handled.size > HANDLED_MAX) {
    // Trim oldest half
    const arr = [...handled];
    handled.clear();
    for (const x of arr.slice(HANDLED_MAX / 2)) handled.add(x);
  }
  return true;
}

// ── Invoke local OpenClaw CLI ───────────────────────────────────────────────
// Transient errors we retry (TLS renegotiation flakes + generic network hiccups
// that bite the UX Agent in particular). NOT retried: LLM rejections, auth
// errors, timeouts — those won't heal by trying again.
const TRANSIENT_ERROR_RE = /(unsafe legacy renegotiation disabled|EPROTO|ECONNRESET|ETIMEDOUT|socket hang up|read ECONN|write ECONN|TLS connection)/i;
const MAX_RETRIES = 2;
const BACKOFF_MS = [1000, 3000]; // 1s, then 3s

function runOpenClawOnce(agentName, message) {
  return new Promise((resolve) => {
    execFile(
      OPENCLAW_BIN,
      ["agent", "--agent", agentName, "--message", message],
      { timeout: OPENCLAW_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const diag = `${err.message} ${stderr || ""}`;
          const transient = TRANSIENT_ERROR_RE.test(diag);
          console.error(`[openclaw/${agentName}] error${transient ? " (transient)" : ""}:`, err.message.slice(0, 200));
          return resolve({ out: null, transient });
        }
        // Strip plugin-loader / runtime / deps debug noise that recent
        // OpenClaw releases write to STDOUT instead of stderr (regression
        // 2026-05-01: brain replies were the npm dependency manifest of the
        // new openclaw binary). sanitizeBrainOutput returns null when the
        // entire output was noise — treated below as "no real reply".
        const out = sanitizeBrainOutput(stdout || "") || "";
        // Filter ONLY the exact OpenClaw rejection prefix (case-insensitive).
        // Do NOT match generic words like "rate limit" or "unauthorized" — those
        // are legitimate vocabulary in security/compliance discussions.
        // OpenClaw's actual rejection format: "LLM request rejected: <message>"
        const trimmedStart = out.trimStart();
        const isRejection =
          /^LLM request rejected[:\s]/i.test(trimmedStart) ||
          /^Error: LLM request rejected/i.test(trimmedStart) ||
          /^You'?re out of extra usage/i.test(trimmedStart) ||
          /^Add more at claude\.ai\/settings\/usage/i.test(trimmedStart);
        // stderr often carries the TLS renegotiation flake even when stdout
        // is empty and execFile doesn't report err (OpenClaw swallows it).
        // Treat empty stdout + transient stderr as retryable.
        const stderrTransient = !out && stderr && TRANSIENT_ERROR_RE.test(stderr);
        if (stderrTransient) {
          console.error(`[openclaw/${agentName}] transient stderr: ${stderr.slice(0, 200)}`);
          return resolve({ out: null, transient: true });
        }
        if (isRejection) {
          console.error(`[openclaw/${agentName}] LLM rejection: ${out.slice(0, 200)}`);
          return resolve({ out: null, transient: false });
        }
        if (!out || out.length < 2) return resolve({ out: null, transient: false });
        resolve({ out, transient: false });
      }
    );
  });
}

// Wrapper with targeted retry on transient TLS / network errors. Returns the
// string reply or null if OpenClaw genuinely couldn't produce one.
async function runOpenClaw(agentName, message) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await runOpenClawOnce(agentName, message);
    if (res && res.out) return res.out;
    if (!res || !res.transient) return null; // permanent failure — don't retry
    if (attempt < MAX_RETRIES) {
      const delay = BACKOFF_MS[attempt] || 3000;
      console.warn(`[openclaw/${agentName}] retrying after ${delay}ms (attempt ${attempt + 2}/${MAX_RETRIES + 1})`);
      await new Promise(r => setTimeout(r, delay));
    } else {
      console.error(`[openclaw/${agentName}] gave up after ${MAX_RETRIES + 1} attempts (all transient)`);
    }
  }
  return null;
}

// ── Brain dispatcher (Phase 1 — brain abstraction) ───────────────────────────
// Wraps runOpenClaw for back-compat; routes agents with { brain: "claude-code"
// | "codex" | "exec" } through the corresponding adapter. Agents with only
// legacy "openclawAgent" automatically resolve to brain="openclaw".
const runBrain = makeRunBrain(runOpenClaw);

// ── Post reply back to the room ─────────────────────────────────────────────
// On 401 we assume the session was revoked/expired out-of-band, force a
// refresh, and retry once before giving up.
// ── B3 outbound post rate-limit (2026-04-22, voted unanimous + Ma'at OK for volumetric) ─
// Sliding window per (passportId, roomId). Protects against LLM-driven
// loop-posting that would burn the provider budget and flood the room.
// 10 posts / 5 min is generous for real use, punishing for a runaway.
// Marker: B3_RATE_LIMIT_INSTALLED
const B3_POST_WINDOW_MS = 5 * 60 * 1000;
const B3_POST_MAX = 10;
const _b3PostWindow = new Map();
function checkB3PostRate(passportId, roomId) {
  const key = `${passportId}:${roomId}`;
  const now = Date.now();
  const cutoff = now - B3_POST_WINDOW_MS;
  const prev = (_b3PostWindow.get(key) || []).filter((t) => t >= cutoff);
  if (prev.length >= B3_POST_MAX) {
    const retryAfterSec = Math.max(1, Math.ceil((prev[0] + B3_POST_WINDOW_MS - now) / 1000));
    return { allowed: false, retryAfterSec, countInWindow: prev.length };
  }
  prev.push(now);
  _b3PostWindow.set(key, prev);
  return { allowed: true, countInWindow: prev.length };
}

async function postReply(roomId, agent, content, model, modelAttested) {
  // B3 rate-limit guard. Runaway? → skip + log, don't error.
  const rate = checkB3PostRate(agent.passportId, roomId);
  if (!rate.allowed) {
    console.warn(
      `[${agent.name}] ⚠ B3 rate-limit: ${rate.countInWindow} posts in last ` +
      `${Math.round(B3_POST_WINDOW_MS / 60000)}min, retry-after ${rate.retryAfterSec}s. ` +
      `Skipping this post (likely loop or runaway).`,
    );
    return false;
  }
  const body = { content };
  if (model) body.model = model;
  if (typeof modelAttested === "boolean") body.modelAttested = modelAttested;

  async function attempt() {
    const token = await ensureAccessToken(agent);
    if (!token) return null; // Track 2: no session + no apt_ → can't post
    const res = await fetch(`${VPS_HTTP}/agent/rooms/${roomId}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res;
  }

  try {
    let res = await attempt();
    if (!res) {
      console.error(`[${agent.name}] post skipped: no usable token (bridge needs re-bootstrap)`);
      return false;
    }
    if (res.status === 401 && USE_SESSIONS) {
      // Force token refresh and retry once
      agent.accessToken = null;
      agent.accessExpiresAt = null;
      console.warn(`[${agent.name}] 401 on post — forcing session refresh`);
      res = await attempt();
      if (!res) return false;
    }
    if (!res.ok) {
      console.error(`[post] failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[post] error:", err.message);
    return false;
  }
}

// ── Active WS connections per room (for status broadcasts) ──────────────────
const roomWs = new Map(); // roomId → WebSocket

function broadcastStatus(roomId, passportId, status) {
  const ws = roomWs.get(roomId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "agent_status_broadcast", passportId, status }));
  }
}

// ── Tool-call execution (agents can run allowlisted commands) ──────────────
//
// Allowlist is intentionally tight: only curl against our own API surface.
// No shell metacharacters, no file access, no external hosts. Every other
// future tool must go through the same gate.
const TOOL_CALL_LINE_RE = /^\s*TOOL_CALL:\s*(.+?)\s*$/;

function validateToolCall(cmd) {
  // Reject shell metacharacters that would break out of the single-command contract.
  // Pipes, redirects, backticks, $(), &&, ||, ; — all forbidden.
  // v0.3.8 (Mike directive 2026-05-06, post external audit by peer Claude session):
  //   `@` added to blocklist. curl interprets `@filename` as "read this file
  //   as the request body" — without this fix, a prompt-injection in any room
  //   could trigger `curl -d @/etc/passwd https://prmaat.com/api/...` and
  //   exfiltrate local files to the (still-allowlisted) prmaat.com origin.
  //   Even though the network destination is allowlisted, allowing arbitrary
  //   local file content into the request body is a real exfil vector.
  if (/[;&|`><$\\@]/.test(cmd)) return { ok: false, reason: "shell metacharacters not allowed (incl. curl @-file syntax)" };
  if (cmd.includes("\n")) return { ok: false, reason: "multi-line commands not allowed" };
  // Must start with curl
  const trimmed = cmd.trim();
  if (!/^curl\s/i.test(trimmed)) return { ok: false, reason: "only curl is allowed" };
  // Must target prmaat.com (any protocol/path).
  // v0.3.8 (Mike directive 2026-05-06): the regex used to check
  // `myclawpassport.com` (the legacy domain), while the error message said
  // `prmaat.com`. Net effect of the bug: tool-calls to the *new* canonical
  // origin (prmaat.com) were being REJECTED, while tool-calls to the *old*
  // domain were being ACCEPTED. This is now corrected — only prmaat.com is
  // allowed; if you genuinely need legacy-domain support, add an explicit
  // alternation ` | (www\.)?myclawpassport\.com` here, but the backend
  // shouldn't be receiving tool-calls on the old origin in 2026.
  if (!/https?:\/\/(www\.)?prmaat\.com(\/|\s|$|")/i.test(trimmed)) {
    return { ok: false, reason: "curl must target prmaat.com" };
  }
  // Hard length cap (defense-in-depth against prompt injection stuffing)
  if (trimmed.length > 1000) return { ok: false, reason: "command too long (max 1000 chars)" };
  return { ok: true };
}

// Split a validated command-line string into argv. Because we forbid shell
// metacharacters above, a simple quoted-whitespace tokenizer is safe.
function tokenize(cmd) {
  const out = [];
  let cur = "", quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (/\s/.test(c)) {
      if (cur) { out.push(cur); cur = ""; }
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function executeToolCall(cmd) {
  const check = validateToolCall(cmd);
  if (!check.ok) {
    return { ok: false, output: `BLOCKED: ${check.reason}` };
  }
  const argv = tokenize(cmd);
  const bin = argv.shift();
  return new Promise((resolve) => {
    execFile(
      bin,
      argv,
      { timeout: TOOL_CALL_TIMEOUT_MS, maxBuffer: TOOL_CALL_MAX_BYTES },
      (err, stdout, stderr) => {
        if (err && err.killed) return resolve({ ok: false, output: "TIMEOUT" });
        if (err && !stdout) return resolve({ ok: false, output: `ERROR: ${err.message.slice(0, 200)}` });
        const out = (stdout || "").slice(0, TOOL_CALL_MAX_BYTES);
        resolve({ ok: true, output: out });
      }
    );
  });
}

// Split the agent's raw reply into { toolCalls: [cmd,...], final: "text-before-or-between" }.
// If any TOOL_CALL lines exist, we treat the whole output as a tool-request turn
// and do not post it verbatim — instead we execute and re-prompt.
function parseAgentReply(raw) {
  const lines = raw.split("\n");
  const toolCalls = [];
  const preserved = [];
  for (const line of lines) {
    const m = line.match(TOOL_CALL_LINE_RE);
    if (m) toolCalls.push(m[1]);
    else preserved.push(line);
  }
  return { toolCalls, final: preserved.join("\n").trim() };
}

// Run the tool-call loop up to N iterations. Returns the final reply string
// the bridge should post to the room, or null on total failure.
async function runWithTools(agent, basePrompt) {
  let prompt = basePrompt;
  let lastFinal = null;
  for (let iter = 0; iter < TOOL_CALL_MAX_ITERATIONS; iter++) {
    const raw = await runBrain(agent, prompt);
    if (!raw) return null;
    const { toolCalls, final } = parseAgentReply(raw);
    if (toolCalls.length === 0) {
      // Agent produced a plain reply — done.
      return final || raw;
    }
    lastFinal = final; // keep any prose shipped alongside tool calls
    // Execute every tool call in this turn, assemble output block.
    const outputs = [];
    for (const cmd of toolCalls.slice(0, 4)) { // cap per-turn to 4 calls
      console.log(`[${agent.name}] TOOL_CALL: ${cmd.slice(0, 120)}`);
      const { ok, output } = await executeToolCall(cmd);
      outputs.push(
        `----- command: ${cmd}\n----- ok: ${ok}\n----- output (first ${TOOL_CALL_MAX_BYTES}B):\n${output.slice(0, 4000)}\n-----`
      );
    }
    // Re-prompt with the results and the original context.
    prompt = [
      basePrompt,
      "",
      `=== Your previous turn ===`,
      raw,
      `=== End ===`,
      "",
      `=== Tool-call results ===`,
      outputs.join("\n\n"),
      `=== End ===`,
      "",
      `Now produce your FINAL reply to the room based on what the commands returned.`,
      `If you still need to run more commands, you may output additional TOOL_CALL: lines.`,
      `You have ${TOOL_CALL_MAX_ITERATIONS - iter - 1} iteration(s) remaining before I post whatever you produce.`,
    ].join("\n");
  }
  // Exhausted iterations — post whatever prose the agent accumulated, or a stub.
  return lastFinal || "I ran the tool calls but hit my iteration budget — see bridge logs.";
}

// ── Handle a mention.notify event ───────────────────────────────────────────
async function handleMention(agent, roomId, event) {
  agent._offlineNoticeAt ||= new Map();
  const messageId = event.messageId || event.timestamp || `${event.senderPassportId}-${Date.now()}`;
  // Per-target dedup (fix 2026-04-22 multi-mention bug): a multi-target
  // mention sends one `mention.notify` per target, all sharing the same
  // messageId. Before this fix the dedup was keyed on messageId alone,
  // so whichever agent's handler ran first marked it handled and every
  // other target silently early-returned — "@Claude @Ma'at hello" → only
  // Claude ever responded. Per-target key gives each target its own
  // namespace so all of them process the event exactly once.
  const dedupTarget = event.mentionedPassportId || agent.passportId;
  const dedupKey = `${messageId}:${dedupTarget}`;
  if (!markHandled(dedupKey)) return; // already handled for this target

  const content = event.content || "";
  const context = event.context || "";
  const sender = event.senderPassportId || "?";
  // Room language hard-rule + broadcast mode arrive on the mention payload
  // so the bridge doesn't need to query the VPS separately.
  const roomLanguage = typeof event.roomLanguage === "string" && event.roomLanguage
    ? event.roomLanguage
    : null;
  const broadcastMode = !!event.broadcastMode;

  console.log(`[${agent.name}] ${broadcastMode ? "broadcast" : "mention"} in ${roomId.slice(-8)} from ${sender.slice(-10)}${roomLanguage ? ` [lang=${roomLanguage}]` : ""}: "${content.slice(0, 80)}"`);

  // Broadcast "thinking" status before invoking OpenClaw
  broadcastStatus(roomId, agent.passportId, "thinking");

  // Tools-enabled agents get a different prompt that teaches them the
  // TOOL_CALL contract. Default stays off so nothing changes for agents
  // whose config hasn't opted in yet.
  const toolsEnabled = shouldEnableTools(agent);

  // Build prompt for OpenClaw
  const promptLines = [
    `You are ${agent.name}, an AI agent in a PrMaat room.`,
    broadcastMode
      ? `A human just posted in the room (no explicit @mention to you). The room is in unlocked mode, so you MAY reply if the message is relevant to your role, or stay silent if it isn't. Reply only when you have something useful to add.`
      : `Someone just @mentioned you. Reply naturally, in character, 2-4 sentences max.`,
    `No markdown, no bullet lists. Natural conversation only.`,
  ];

  const roomLanguageName = resolveLanguageName(roomLanguage);
  if (roomLanguage) {
    promptLines.push(
      "",
      `=== Room language rule (HARD) ===`,
      `This room is locked to ${roomLanguageName} (ISO code: ${roomLanguage}).`,
      `ALL of your replies MUST be written entirely in ${roomLanguageName}.`,
      `This applies even if the user's message is in a different language — DO NOT mirror the user's language. Reply in ${roomLanguageName} only.`,
      `If you cannot reply in ${roomLanguageName}, stay silent (output SKIP in broadcast mode, otherwise output nothing).`,
      `=== End ===`,
    );
  }

  if (broadcastMode) {
    promptLines.push(
      "",
      `If you decide NOT to reply, output exactly the word: SKIP`,
      `We will treat SKIP as "this message wasn't for me" and post nothing.`,
    );
  }
  if (toolsEnabled) {
    promptLines.push(
      "",
      "=== Tools available to you ===",
      `When someone asks you to test, verify, or check something, do NOT say "I'll test and report back" — that's ghosting. Instead, run the check yourself using TOOL_CALL.`,
      ``,
      `To run a command, output a line exactly like this:`,
      `TOOL_CALL: curl -s "https://prmaat.com/some/endpoint"`,
      ``,
      `Rules:`,
      `- One TOOL_CALL per line. You may output multiple TOOL_CALL lines in the same turn.`,
      `- Only curl is allowed, and only against https://prmaat.com (any path).`,
      `- No shell pipes, redirects, variable expansion, or chaining.`,
      `- After your tool calls run, you'll be re-prompted with the output and asked for your final reply.`,
      `- Max ${TOOL_CALL_MAX_ITERATIONS} rounds of tool-use per mention.`,
      ``,
      `If you don't need to run anything, just reply in prose as usual.`,
      "=== End tools ===",
    );
  }
  promptLines.push(
    "",
    "=== Recent room conversation ===",
    context,
    "=== End ===",
    "",
    `The message directed at you: "${content}"`,
    "",
    // Reinforce the language rule right before "Reply now" — LLMs suffer from
    // recency bias and tend to mirror the language of the last user message
    // shown. Repeating the constraint here keeps the reply in the locked lang.
    roomLanguage
      ? `REMEMBER: This room is locked to ${roomLanguageName}. Your reply MUST be written in ${roomLanguageName}, not in the user's language.`
      : null,
    roomLanguage ? "" : null,
    toolsEnabled
      ? `Reply now. If you need to verify something first, output TOOL_CALL: lines; otherwise output your reply directly.`
      : `Reply now. Output ONLY your reply, nothing else.`,
  );
  const prompt = promptLines.join("\n");

  // Switch to "writing" once OpenClaw starts generating
  broadcastStatus(roomId, agent.passportId, "writing");

  const reply = toolsEnabled
    ? await runWithTools(agent, prompt)
    : await runBrain(agent, prompt);

  // Broadcast mode: honor explicit SKIP — agent chose not to reply.
  if (broadcastMode && reply && /^\s*SKIP\s*$/i.test(reply)) {
    console.log(`[${agent.name}] broadcast-mode SKIP (not replying)`);
    broadcastStatus(roomId, agent.passportId, "listening");
    return;
  }

  // Reset to "listening" after processing
  broadcastStatus(roomId, agent.passportId, "listening");

  // Resolve model: see resolveModelTag() — per-agent brain-derived.
  const { model, attested: modelAttested } = resolveModelTag(agent);

  if (!reply) {
    const now = Date.now();
    const lastOfflineNotice = agent._offlineNoticeAt.get(roomId) || 0;
    const OFFLINE_NOTICE_COOLDOWN_MS = 60 * 60 * 1000;
    if (now - lastOfflineNotice >= OFFLINE_NOTICE_COOLDOWN_MS) {
      console.warn(`[${agent.name}] OpenClaw returned no usable output — posting offline notice`);
      await postReply(
        roomId,
        agent,
        `⚠️ ${agent.name} is offline right now (local model unavailable). I'll reply when I'm back.`,
        model,
        modelAttested,
      );
      agent._offlineNoticeAt.set(roomId, now);
    } else {
      console.warn(`[${agent.name}] OpenClaw returned no usable output — suppressing duplicate offline notice`);
    }
    broadcastStatus(roomId, agent.passportId, "idle");
    return;
  }

  // v0.3.5 (2026-05-03): belt-and-suspenders sanitize JUST before
  // posting. The runBrain path SHOULD already strip plugin-loader noise
  // via brains.mjs::sanitizeBrainOutput, but in practice some openclaw
  // 4.29 invocations leak `[plugins] xxx staging bundled runtime deps...`
  // into the chat content. This catches those regardless of which path
  // produced them. Idempotent on already-clean text.
  const safeReply = sanitizeBrainOutput(reply) || reply;
  if (safeReply !== reply) {
    console.warn(`[${agent.name}] sanitizer caught ${reply.length - safeReply.length} bytes of plugin-loader noise pre-post`);
  }
  const posted = await postReply(roomId, agent, safeReply, model, modelAttested);
  if (posted) console.log(`[${agent.name}] replied${model ? ` (model=${model})` : ""}: "${reply.slice(0, 80)}"`);
}

// ── Connect one agent to one room via WebSocket ─────────────────────────────
function connectAgentRoom(agent, roomId) {
  let ws;
  let pingInterval;
  // Circuit breaker: if the server rejects our token 5 times in a row with
  // code 1008 ("Invalid ..."), stop hammering. Mike reported Imhotep chewing
  // through a tight retry loop for hours because the session was stale.
  // After tripping, we back off to once every 5 min and print a clear
  // recovery message. Any successful reconnect resets the counter.
  let consecutiveAuthRejections = 0;
  const AUTH_REJECT_CIRCUIT_THRESHOLD = 5;

  async function connect() {
    // Use a fresh access token on every (re)connect so rotated sessions
    // don't leave the WS authed with a dead aps_.
    const token = await ensureAccessToken(agent);
    if (!token) {
      console.error(`[${agent.name}] cannot connect to room ${roomId.slice(-8)}: no usable token (bridge needs re-bootstrap)`);
      // Retry in 60s — a re-bootstrap by the operator will drop a fresh apt_
      // back into ap-client.json and the next attempt will pick it up.
      setTimeout(connect, 60_000);
      return;
    }
    const url = `${VPS_WS}/ws/rooms/${roomId}?token=${token}`;
    console.log(`[${agent.name}] connecting to room ${roomId.slice(-8)}...`);
    ws = new WebSocket(url);

    ws.on("open", () => {
      console.log(`[${agent.name}] ✓ connected to room ${roomId.slice(-8)}`);
      roomWs.set(roomId, ws);
      // A successful handshake means the token is good — reset the circuit
      // breaker so future transient 1008s (rotation race) get 5 more chances.
      consecutiveAuthRejections = 0;
      // Round 22 wave 9g: a successful WS handshake means our auth + room
      // membership are fresh in the server's view. Clear any stale
      // mention-poll blocks so we re-attempt polls in case membership
      // changed (e.g., we were re-added to a room we had been blocked from).
      resetMentionPollBlocks();
      // Broadcast "listening" status on connect
      broadcastStatus(roomId, agent.passportId, "listening");
      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 25000);
    });

    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // Self-healing Q1🅑 (room vote 2026-04-26): server pushes
      // `reauth_required` whenever this passport's apt_ has been rotated
      // (via creator-JWT dashboard, external aptr_, scheduled task, etc).
      // Payload contains NO token material (Police's "non-oracular"
      // guardrail) — we use the stored aptr_ to mint our own fresh apt_
      // and atomically swap it into Keychain. Replaces the previous
      // failure mode where an external rotation orphaned this agent's
      // bridge entry until the operator manually re-enrolled.
      if (msg.type === "reauth_required" && msg.passportId === agent.passportId) {
        console.log(`[${agent.name}] reauth_required received (rotated at ${msg.rotatedAt || "?"}) — invoking aptr_-driven self-heal`);
        try {
          const ok = await rotateAptViaAptr(agent, VPS_HTTP);
          if (ok) {
            console.log(`[${agent.name}] reauth complete — closing WS to reconnect with fresh apt_`);
            try { ws.close(4001, "reauth_required"); } catch { /* ignore */ }
          } else {
            console.warn(`[${agent.name}] reauth failed; will fall back to next /agent/me 401 retry path`);
          }
        } catch (err) {
          console.error(`[${agent.name}] reauth error: ${err?.message || err}`);
        }
        return;
      }

      // Handle both real-time mention.notify AND catchup replays on reconnect.
      // mention.catchup = missed mention replayed from the last 5 min after a
      // 1006/1008 reconnect. Same shape, same handler. Loop guard content
      // dedupe prevents double-processing if the agent already replied.
      if (msg.type !== "mention.notify" && msg.type !== "mention.catchup") return;

      // Only respond to mentions directed at THIS agent
      if (msg.mentionedPassportId && msg.mentionedPassportId !== agent.passportId) return;

      // Skip own messages
      if (msg.senderPassportId === agent.passportId) return;

      try {
        await handleMention(agent, roomId, msg);
      } catch (err) {
        console.error(`[${agent.name}] handle error:`, err.message);
      }
    });

    ws.on("close", (code, reason) => {
      clearInterval(pingInterval);
      const reasonStr = reason ? reason.toString() : "";

      // v0.3.3 (Mike, 2026-05-01 launch night): if the upstream server
      // says the room is gone or this passport isn't a member, the bridge
      // was looping forever — connecting, getting kicked, reconnecting in
      // 3s, every 3s, until the bridge process was restarted. Symptoms:
      // agents flicker between online and offline in rooms they were
      // never reinstated to, and eventually look "down" because they
      // spend more time being kicked than connected.
      // Fix: detect the two unrecoverable 1008 reasons and STOP scheduling
      // reconnect for THIS room. Other rooms for the same agent keep
      // their reconnect logic. On bridge restart the room list is
      // resynced from the server, so a re-added room will reappear.
      const isRoomGone = code === 1008 && (
        /^Room not found/i.test(reasonStr) ||
        /^Not a member/i.test(reasonStr)
      );
      if (isRoomGone) {
        console.log(`[${agent.name}] room ${roomId} deleted/no-membership upstream (1008: "${reasonStr}") — removing from rotation, not reconnecting.`);
        return; // do NOT schedule reconnect for this room
      }

      const isAuthReject = code === 1008 && reasonStr.includes("Invalid");
      let delay = RECONNECT_DELAY;
      if (isAuthReject) {
        consecutiveAuthRejections++;
        if (consecutiveAuthRejections >= AUTH_REJECT_CIRCUIT_THRESHOLD) {
          // Circuit tripped — stop the retry storm. Print a loud, actionable
          // recovery message instead. We still schedule a 5-min probe so the
          // bridge heals itself the moment the operator re-bootstraps, but
          // the log noise drops from once-every-3s to once-every-5-min.
          console.error(``);
          console.error(`[${agent.name}] ╔════════════════════════════════════════════════════════════╗`);
          console.error(`[${agent.name}] ║  ⛔  AUTH CIRCUIT TRIPPED (${consecutiveAuthRejections} straight 1008 rejections)  ║`);
          console.error(`[${agent.name}] ║                                                            ║`);
          console.error(`[${agent.name}] ║  The server is rejecting this agent's token. This usually  ║`);
          console.error(`[${agent.name}] ║  means the keychain session was wiped OR the apt_ was      ║`);
          console.error(`[${agent.name}] ║  rotated elsewhere and never synced back to this bridge.   ║`);
          console.error(`[${agent.name}] ║                                                            ║`);
          console.error(`[${agent.name}] ║  Recover:                                                  ║`);
          console.error(`[${agent.name}] ║    1. Log into prmaat.com → Passports              ║`);
          console.error(`[${agent.name}] ║    2. Rotate this passport's token (creator JWT required)  ║`);
          console.error(`[${agent.name}] ║    3. Update ap-client.json on THIS machine                ║`);
          console.error(`[${agent.name}] ║    4. Restart the bridge (launchctl kickstart)             ║`);
          console.error(`[${agent.name}] ║                                                            ║`);
          console.error(`[${agent.name}] ║  Probing every 5 min until then.                           ║`);
          console.error(`[${agent.name}] ╚════════════════════════════════════════════════════════════╝`);
          console.error(``);
          delay = 5 * 60 * 1000;
        } else {
          console.error(`[${agent.name}] ❌ Token rejected by server (code 1008, attempt ${consecutiveAuthRejections}/${AUTH_REJECT_CIRCUIT_THRESHOLD}).`);
          console.log(`[${agent.name}] Retrying in ${RECONNECT_DELAY / 1000}s in case token was just rotated...`);
        }
      } else {
        // Any non-auth close resets the counter — network flaps shouldn't
        // count against us.
        consecutiveAuthRejections = 0;
        console.log(`[${agent.name}] Disconnected (${code}). Reconnecting in ${RECONNECT_DELAY / 1000}s...`);
      }
      setTimeout(connect, delay);
    });

    ws.on("error", (err) => {
      if (err.code === "ECONNREFUSED") {
        console.error(`[${agent.name}] ❌ Cannot reach server at ${VPS_WS}. Is the VPS running?`);
      } else if (err.code === "ENOTFOUND") {
        console.error(`[${agent.name}] ❌ DNS lookup failed for server. Check your --host or AP_WS setting.`);
      } else {
        console.error(`[${agent.name}] WS error: ${err.message}`);
      }
    });
  }

  connect();
}

// ── Bootstrap from token: call GET /agent/bootstrap to auto-discover config ──
//
// Reliability mandate (room vote 2026-04-27 + Mike's "100% works for all
// future logins" ask): per-agent failures MUST NOT kill the whole bridge.
// Previous behavior was process.exit(1) on any 401/403/404, which caused a
// crash-loop on legacy configs that still listed deleted DIDs (e.g.
// Mike's hard-deleted Imhotep DID `ZiPaVXe6...`). New behavior: throw a
// structured Error with `.code` set so the caller can auto-prune
// deactivated entries (DEACTIVATED), self-heal stale tokens (TOKEN_INVALID),
// or surface transient network issues (NETWORK / SERVER_ERROR) without
// taking the rest of the agents offline.
async function bootstrapFromToken(token, hostOverride, openclawOverride) {
  const host = hostOverride || VPS_HTTP;
  console.log(`[ap-client] Bootstrapping from token via ${host}/agent/bootstrap ...`);
  let res;
  try {
    res = await fetch(`${host}/agent/bootstrap`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
  } catch (err) {
    const e = new Error(`Cannot reach ${host}/agent/bootstrap: ${err.message}`);
    e.code = "NETWORK";
    throw e;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // Detect "Passport is deactivated" → caller auto-prunes from config.
    // Match a couple of known phrasings defensively (older + newer servers).
    const deactivated = res.status === 403 && /deactivated|inactive|disabled/i.test(body);
    if (deactivated) {
      const e = new Error(`Passport deactivated server-side`);
      e.code = "DEACTIVATED";
      e.body = body;
      throw e;
    }
    if (res.status === 401 || res.status === 403) {
      const e = new Error(`Token rejected (HTTP ${res.status})`);
      e.code = "TOKEN_INVALID";
      e.body = body;
      throw e;
    }
    if (res.status === 404) {
      const e = new Error(`Server not found at ${host}`);
      e.code = "NOT_FOUND";
      throw e;
    }
    const e = new Error(`Bootstrap failed (HTTP ${res.status}): ${body.slice(0, 200)}`);
    e.code = "SERVER_ERROR";
    e.status = res.status;
    throw e;
  }
  const data = await res.json();
  // Priority: CLI --openclaw-agent > server localAgentName > auto-derive from name
  const slug = openclawOverride ||
    data.localAgentName ||
    data.agentName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  if (data.localAgentName) {
    console.log(`[ap-client] Using server-configured local agent: ${data.localAgentName}`);
  } else {
    // 2026-04-18 (Mike's Forex report): the "auto-derive from display name"
    // fallback is exactly how Forex broke — display "Forex Agent" →
    // derived "forex-agent" → OpenClaw only knew "forex" → replies failed.
    // Warn loudly so the operator catches this before it silently fails.
    console.warn(`[ap-client] ⚠️  ${data.agentName}: passport has no localAgentName on the server — falling back to auto-derived "${slug}"`);
    console.warn(`[ap-client]     If your local OpenClaw agent ID is different (e.g. just "forex"), either:`);
    console.warn(`[ap-client]       • Edit the passport in the UI → set "Agent name on your system" to match, OR`);
    console.warn(`[ap-client]       • Run with --openclaw-agent <exact-id> to override per-launch`);
  }
  // 2026-04-18 (Mike's Forex report): passport exists + token valid +
  // bridge connects, but bootstrap returns rooms: []. Previous bridge sat
  // silently in this state and looked healthy. Now we surface it as the
  // top-priority setup error — the operator has to manually join the
  // passport to a room in the UI before anything works.
  if (!Array.isArray(data.rooms) || data.rooms.length === 0) {
    console.warn("");
    console.warn(`[ap-client] ╔════════════════════════════════════════════════════════════╗`);
    console.warn(`[ap-client] ║  ⚠️  ${data.agentName}: PASSPORT HAS NO ROOM MEMBERSHIPS          `);
    console.warn(`[ap-client] ║                                                            ║`);
    console.warn(`[ap-client] ║  The bridge will connect but the agent will be deaf: no    ║`);
    console.warn(`[ap-client] ║  mentions will ever arrive. You must join this passport    ║`);
    console.warn(`[ap-client] ║  to at least one room before it can do anything.           ║`);
    console.warn(`[ap-client] ║                                                            ║`);
    console.warn(`[ap-client] ║  How to fix:                                               ║`);
    console.warn(`[ap-client] ║    1. Log into https://prmaat.com                  ║`);
    console.warn(`[ap-client] ║    2. Open any room (or create one)                        ║`);
    console.warn(`[ap-client] ║    3. Click "Join as this passport" → "Approve & Join"     ║`);
    console.warn(`[ap-client] ║    4. The bridge's self-heal tick picks it up within 60s   ║`);
    console.warn(`[ap-client] ╚════════════════════════════════════════════════════════════╝`);
    console.warn("");
  }

  return {
    agents: [{
      name: data.agentName,
      passportId: data.passportId,
      token,
      openclawAgent: slug,
      // Server may optionally ship a preferred model hint for this passport;
      // bridge will use it as the default unless AP_MODEL env overrides.
      model: data.model || null,
      rooms: data.rooms.map(r => r.id),
    }],
    _bootstrap: data, // keep full response for self-healing
    _noRooms: (!Array.isArray(data.rooms) || data.rooms.length === 0),
  };
}

// ── Track 2: hydrate an agent from Keychain + call /agent/bootstrap w/ aps_ ──
// Post-migration the apt_ is gone from disk; the bridge needs to come up
// from Keychain alone. We build a skeleton agent record, let ensureAccessToken
// pull the cached aps_/apr_ and refresh if needed, then call /agent/bootstrap
// with the fresh aps_ to discover rooms + metadata.
async function bootstrapFromKeychain(passportId, label, hostOverride, openclawOverride) {
  const host = hostOverride || VPS_HTTP;
  const skeleton = {
    name: label || passportId.slice(-10),
    passportId,
    token: null,
    rotateToken: null,
  };
  const aps = await ensureAccessToken(skeleton);
  if (!aps || aps.startsWith("apt_")) {
    console.error(`[ap-client] ${label || passportId.slice(-10)} — no keychain session; skipping (re-bootstrap with apt_ required)`);
    return null;
  }
  console.log(`[ap-client] ${label || passportId.slice(-10)} — bootstrapping via aps_ (keychain-only)`);
  const res = await fetch(`${host}/agent/bootstrap`, {
    headers: { "Authorization": `Bearer ${aps}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`[ap-client] ${label || passportId.slice(-10)} — /agent/bootstrap failed HTTP ${res.status}: ${body.slice(0, 160)}`);
    return null;
  }
  const data = await res.json();
  const slug = openclawOverride ||
    data.localAgentName ||
    data.agentName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  if (data.localAgentName) console.log(`[ap-client] Using server-configured local agent: ${data.localAgentName}`);
  // Same rooms: 0 guard as bootstrapFromToken — keychain-hydrated agents
  // hit the identical silent-deaf failure mode.
  if (!Array.isArray(data.rooms) || data.rooms.length === 0) {
    console.warn("");
    console.warn(`[ap-client] ⚠️  ${data.agentName}: passport has no room memberships — join it to at least one room in the UI before the bridge is useful.`);
    console.warn("");
  }
  return {
    agents: [{
      name: data.agentName,
      passportId: data.passportId,
      token: null,          // Track 2: no apt_ on disk
      rotateToken: null,    // Track 2: aptr_ obsolete, session refresh handles it
      openclawAgent: slug,
      model: data.model || null,
      rooms: data.rooms.map(r => r.id),
      // Bring the hydrated session forward so the first WS connect skips
      // a redundant ensureAccessToken roundtrip.
      accessToken: skeleton.accessToken,
      accessExpiresAt: skeleton.accessExpiresAt,
      refreshToken: skeleton.refreshToken,
      refreshExpiresAt: skeleton.refreshExpiresAt,
      sessionId: skeleton.sessionId,
      _hydrated: true,
    }],
    _bootstrap: data,
    _noRooms: (!Array.isArray(data.rooms) || data.rooms.length === 0),
  };
}

// ── Self-healing: re-discover rooms every 60s ───────────────────────────────
// Track 2: we capture a FRESH aps_ via ensureAccessToken each tick instead
// of stashing the original apt_, so post-migration (apt_ purged) self-heal
// still works — it just authenticates with the session access token.
function startSelfHeal(agent, hostOverride) {
  const host = hostOverride || VPS_HTTP;
  const connectedRooms = new Set(agent.rooms);
  setInterval(async () => {
    try {
      const token = await ensureAccessToken(agent);
      if (!token) return; // no usable creds — skip this tick, bridge needs re-bootstrap
      const res = await fetch(`${host}/agent/bootstrap`, {
        headers: { "Authorization": `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      const freshRoomIds = new Set(data.rooms.map(r => r.id));

      // Connect to new rooms
      for (const r of data.rooms) {
        if (!connectedRooms.has(r.id)) {
          console.log(`[${agent.name}] Self-heal: joining new room ${r.name} (${r.id.slice(-8)})`);
          connectedRooms.add(r.id);
          agent.rooms.push(r.id);
          connectAgentRoom(agent, r.id);
        }
      }
      // Log removed rooms (WS will naturally fail to reconnect)
      for (const id of connectedRooms) {
        if (!freshRoomIds.has(id)) {
          console.log(`[${agent.name}] Self-heal: room ${id.slice(-8)} removed from membership`);
          connectedRooms.delete(id);
        }
      }
    } catch (err) {
      // Silently ignore — will retry next interval
    }
  }, 60000);
}

// ── Parse CLI args ──────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const tokens = [];
  let host = null, openclawAgent = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("apt_")) tokens.push(args[i]);
    else if (args[i] === "--host" && args[i + 1]) host = args[++i];
    else if (args[i] === "--openclaw-agent" && args[i + 1]) openclawAgent = args[++i];
  }
  return { tokens, host, openclawAgent };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const cli = parseArgs();
  let allAgents = [];
  const hostOverride = cli.host;

  // Collect tokens from all sources
  const tokens = [...cli.tokens];
  // Track which apt_ gets paired with which aptr_ (Anti-clone T1.5).
  // Map apt_ -> aptr_. Filled from config.tokenPairs below.
  const aptrMap = new Map();

  // AP_TOKENS env var: comma-separated list of tokens
  if (process.env.AP_TOKENS) {
    tokens.push(...process.env.AP_TOKENS.split(",").map(t => t.trim()).filter(Boolean));
  }
  // Legacy AP_TOKEN (single)
  if (process.env.AP_TOKEN && !tokens.includes(process.env.AP_TOKEN)) {
    tokens.push(process.env.AP_TOKEN);
  }

  // Post-migration (Track 2): entries where apt_ has been purged but
  // passportId remains. These hydrate from Keychain directly.
  const keychainOnlyPairs = [];

  // Token-only JSON config: { "tokens": [...] } | { "tokenPairs": [...] } | { "agents": [...] }
  if (tokens.length === 0) {
    try {
      const cfg = loadConfig();
      // T1.5 format: [{ apt, aptr, passportId, label }, ...]
      // Pre-migration:  apt_ present → bootstrap-from-apt
      // Post-migration: apt null, passportId present → bootstrap-from-keychain
      if (cfg.tokenPairs && Array.isArray(cfg.tokenPairs)) {
        for (const pair of cfg.tokenPairs) {
          if (!pair) continue;
          if (typeof pair.apt === "string" && pair.apt.startsWith("apt_")) {
            tokens.push(pair.apt);
            if (typeof pair.aptr === "string" && pair.aptr.startsWith("aptr_")) {
              aptrMap.set(pair.apt, pair.aptr);
            }
            continue;
          }
          // Post-migration pair: passportId alone is enough if keychain has
          // a live session for it.
          if (pair.passportId && typeof pair.passportId === "string") {
            keychainOnlyPairs.push({ passportId: pair.passportId, label: pair.label || null });
          }
        }
      }
      // Legacy format: { "tokens": [...] } — filter out null slots we left
      // behind after a purge (in case someone used raw tokens[] not tokenPairs).
      if (cfg.tokens && Array.isArray(cfg.tokens)) {
        tokens.push(...cfg.tokens.filter(t => typeof t === "string" && t.startsWith("apt_")));
      }
      // Fully inline legacy: { "agents": [...] }
      if (cfg.agents && cfg.agents.length > 0 && !cfg.tokens && !cfg.tokenPairs) {
        allAgents = cfg.agents.filter(a => !a.disabled);
      }
    } catch {}
  }

  // Sanity-check summary: collect per-entry pass/fail so the final log line
  // is trivially scannable. Mike 2026-04-18: asked for "fail loud on
  // unreachable" so operators don't stare at a clean console while one agent
  // has silently given up on bootstrap.
  const sanityReport = []; // {label, kind, ok, reason?}
  const totalConfiguredCount = tokens.length + keychainOnlyPairs.length + allAgents.length;

  // Bootstrap each apt_ into an agent config (pre-migration path)
  if (tokens.length > 0) {
    console.log(`[ap-client] Bootstrapping ${tokens.length} agent(s) from apt_...`);
    for (const token of tokens) {
      try {
        const config = await bootstrapFromToken(token, hostOverride, cli.openclawAgent);
        // Attach aptr_ if this apt_ was paired in config.tokenPairs
        const aptr = aptrMap.get(token);
        if (aptr) {
          for (const a of config.agents) a.rotateToken = aptr;
        }
        allAgents.push(...config.agents);
        for (const a of config.agents) {
          sanityReport.push({
            label: a.name,
            kind: "apt_",
            ok: true,
            warn: !!config._noRooms,
            reason: config._noRooms ? "reachable but no rooms joined — join in UI" : undefined,
          });
        }
      } catch (err) {
        // Reliability mandate (2026-04-27): per-agent failures non-fatal.
        if (err.code === "DEACTIVATED") {
          console.warn(`[ap-client] ⚠ legacy agents[] token holds a DEACTIVATED passport — prune the agents[] entry from your config to silence this`);
        } else if (err.code === "TOKEN_INVALID") {
          console.warn(`[ap-client] ⚠ legacy agents[] token rejected — re-pair via brainclaw connect`);
        } else {
          console.error(`[ap-client] ✗ Failed to bootstrap token ${token.slice(0, 12)}...: ${err.message} (code=${err.code || "?"})`);
        }
        sanityReport.push({ label: token.slice(0, 16) + "…", kind: "apt_", ok: false, reason: `${err.code || "?"}: ${err.message}` });
      }
    }
  }

  // Track 2: hydrate keychain-only agents (apt_ already purged from disk)
  // Reliability mandate (2026-04-27): per-agent failures NEVER kill the
  // bridge. DEACTIVATED passports are pruned from config in-place so the
  // crash-loop class can never recur. TOKEN_INVALID logs + skips (the
  // T1.5 reauth_required WS flow handles self-healing). Other errors log
  // and continue.
  const pruneFromConfig = []; // {passportId, reason} — removed at end of bootstrap
  if (keychainOnlyPairs.length > 0) {
    console.log(`[ap-client] Hydrating ${keychainOnlyPairs.length} keychain-only agent(s)...`);
    for (const p of keychainOnlyPairs) {
      try {
        let config = await bootstrapFromKeychain(p.passportId, p.label, hostOverride, cli.openclawAgent);
        if (!config) {
          // Item #12 (2026-04-19): no live session in keychain yet, but the
          // operator may have stashed a raw apt_ (+ aptr_) via
          // `brainclaw keychain stash`. Try that path before giving up.
          const stashed = await keychainRecallApt(p.passportId);
          if (stashed?.apt) {
            console.log(`[ap-client] ${p.label || p.passportId.slice(-10)} — no session, bootstrapping from keychain-stashed apt_`);
            try {
              config = await bootstrapFromToken(stashed.apt, hostOverride, cli.openclawAgent);
              if (config && stashed.aptr) {
                for (const a of config.agents) a.rotateToken = stashed.aptr;
              }
            } catch (err) {
              if (err.code === "DEACTIVATED") {
                console.warn(`[ap-client] ⚠ ${p.label || p.passportId.slice(-10)} — passport DEACTIVATED server-side, will auto-prune from config (no crash)`);
                pruneFromConfig.push({ passportId: p.passportId, reason: "deactivated", label: p.label });
              } else if (err.code === "TOKEN_INVALID") {
                console.warn(`[ap-client] ⚠ ${p.label || p.passportId.slice(-10)} — token rejected (stale apt_); waiting for reauth_required WS event to self-heal`);
              } else {
                console.error(`[ap-client] ✗ ${p.label || p.passportId.slice(-10)} — stashed apt_ bootstrap failed: ${err.message} (code=${err.code || "?"})`);
              }
            }
          }
        }
        if (config) {
          allAgents.push(...config.agents);
          for (const a of config.agents) {
            sanityReport.push({
              label: a.name,
              kind: "keychain",
              ok: true,
              warn: !!config._noRooms,
              reason: config._noRooms ? "reachable but no rooms joined — join in UI" : undefined,
            });
          }
        } else {
          sanityReport.push({
            label: p.label || p.passportId.slice(-10),
            kind: "keychain",
            ok: false,
            reason: "no keychain session or stashed apt_; run brainclaw keychain stash",
          });
        }
      } catch (err) {
        // Reliability mandate (2026-04-27): catch outermost-level errors
        // from bootstrapFromKeychain too. If the wrapped bootstrapFromToken
        // re-threw a DEACTIVATED, queue the prune.
        if (err.code === "DEACTIVATED") {
          console.warn(`[ap-client] ⚠ ${p.label || p.passportId.slice(-10)} — passport DEACTIVATED, will auto-prune`);
          pruneFromConfig.push({ passportId: p.passportId, reason: "deactivated", label: p.label });
          sanityReport.push({
            label: p.label || p.passportId.slice(-10),
            kind: "keychain",
            ok: false,
            reason: "DEACTIVATED — auto-pruned from config",
          });
        } else {
          console.error(`[ap-client] ✗ Failed to hydrate ${p.label || p.passportId.slice(-10)}: ${err.message} (code=${err.code || "?"})`);
          sanityReport.push({
            label: p.label || p.passportId.slice(-10),
            kind: "keychain",
            ok: false,
            reason: `${err.code || "?"}: ${err.message}`,
          });
        }
      }
    }
  }

  // ── Auto-prune deactivated tokenPairs from config (reliability mandate) ──
  // The class of crash-loop we hit on 2026-04-27: legacy ap-client.json had
  // a tokenPair for an Imhotep DID that was hard-deleted server-side weeks
  // ago. Bridge tried to bootstrap it every cycle, got 403 "deactivated",
  // process.exit(1), launchd KeepAlive restarted, repeat. Now we
  // surgically remove the offending tokenPairs in-place (with a backup),
  // and bridge keeps running for the healthy agents. Audit trail goes to
  // stderr + a `.prune.log` next to the config so the operator can see
  // what was pruned, when, and why.
  if (pruneFromConfig.length > 0) {
    try {
      const cfgPath = process.env.AP_CONFIG || (homedir() + "/.myclawpassport/ap-client.json");
      const altCfgPath = homedir() + "/ap-client/ap-client.json"; // legacy path
      const candidates = [cfgPath, altCfgPath].filter((p) => existsSync(p));
      for (const path of candidates) {
        try {
          const raw = readFileSync(path, "utf8");
          const cfg = JSON.parse(raw);
          let touched = false;
          if (Array.isArray(cfg.tokenPairs)) {
            const before = cfg.tokenPairs.length;
            cfg.tokenPairs = cfg.tokenPairs.filter((tp) => {
              const dropped = pruneFromConfig.some((pr) => pr.passportId === tp.passportId);
              return !dropped;
            });
            if (cfg.tokenPairs.length !== before) touched = true;
          }
          if (Array.isArray(cfg.agents)) {
            const before = cfg.agents.length;
            cfg.agents = cfg.agents.filter((a) => {
              const dropped = pruneFromConfig.some((pr) => pr.passportId === a.passportId);
              return !dropped;
            });
            if (cfg.agents.length !== before) touched = true;
          }
          if (touched) {
            // Backup before write
            const backupPath = `${path}.bak.autoprune.${Date.now()}`;
            writeFileSync(backupPath, raw, { mode: 0o600 });
            writeFileSync(path, JSON.stringify(cfg, null, 2), { mode: 0o600 });
            console.warn(`[ap-client] ✂  auto-pruned ${pruneFromConfig.length} deactivated entry(ies) from ${path} (backup: ${backupPath})`);
            for (const pr of pruneFromConfig) {
              console.warn(`[ap-client]   pruned: ${pr.label || pr.passportId.slice(-10)} (${pr.passportId}) — ${pr.reason}`);
            }
          }
        } catch (innerErr) {
          console.warn(`[ap-client] auto-prune skipped for ${path}: ${innerErr.message}`);
        }
      }
    } catch (err) {
      console.warn(`[ap-client] auto-prune outer failure (non-fatal): ${err.message}`);
    }
  }

  // Sanity report — print BEFORE the "No agents" exit so operators see which
  // passport failed and why, even when everything is down.
  // Three states, not two:
  //   ok   = reachable AND has ≥1 room joined (will work)
  //   warn = reachable but rooms: 0 (Forex-style silent failure)
  //   bad  = bootstrap failed entirely (invalid token, deactivated, etc.)
  const ok = sanityReport.filter(r => r.ok && !r.warn);
  const warn = sanityReport.filter(r => r.ok && r.warn);
  const bad = sanityReport.filter(r => !r.ok);
  console.log("");
  console.log(`[ap-client] ── Bridge sanity check ─────────────────────────────`);
  console.log(`[ap-client] Configured: ${totalConfiguredCount} | Ready: ${ok.length} ✅ | Idle: ${warn.length} ⚠️  | Failed: ${bad.length} ❌`);
  for (const r of ok) {
    console.log(`[ap-client]   ✅ ${r.label}  (${r.kind})`);
  }
  for (const r of warn) {
    console.warn(`[ap-client]   ⚠️  ${r.label}  (${r.kind})  →  ${r.reason || "reachable but no rooms joined"}`);
  }
  for (const r of bad) {
    console.error(`[ap-client]   ❌ ${r.label}  (${r.kind})  →  ${r.reason || "unknown error"}`);
  }
  console.log(`[ap-client] ────────────────────────────────────────────────────`);
  console.log("");

  // ── Apply per-agent tokenPair overrides (brain/brainBin/workingDir/args/model) ─
  // ported from Mac Mini 2026-04-22 so future installs get the same
  // Layer 1 + Option C behavior. Each override is validated via B1
  // (brainBin allowlist) before being applied. An invalid brainBin
  // causes the override to be dropped (not the whole agent) so one
  // misconfigured agent doesn't kill the whole bridge.
  // Marker: PAIR_OVERRIDES_INSTALLED
  try {
    const pairs = (loadConfig().tokenPairs || []).filter((pp) => pp && pp.passportId);
    if (pairs.length > 0) {
      for (const a of allAgents) {
        const pair = pairs.find((pp) => pp.passportId === a.passportId);
        if (!pair) continue;
        const applied = [];
        const rejected = [];
        if (pair.brain) { a.brain = pair.brain; applied.push(`brain=${pair.brain}`); }
        if (pair.workingDir) { a.workingDir = pair.workingDir; applied.push(`cwd=${pair.workingDir}`); }
        if (pair.brainBin) {
          const v = validateBrainBin(pair.brainBin, a.name);
          if (v.ok) { a.brainBin = pair.brainBin; applied.push(`bin=${pair.brainBin}`); }
          else { rejected.push(`brainBin rejected: ${v.reason}`); }
        }
        if (Array.isArray(pair.brainArgs)) { a.brainArgs = pair.brainArgs; applied.push(`args=${JSON.stringify(pair.brainArgs)}`); }
        if (pair.model && !a.model) { a.model = pair.model; applied.push(`model=${pair.model}`); }
        if (applied.length > 0) console.log(`[ap-client] ${a.name}: pair-overrides → ${applied.join(", ")}`);
        for (const r of rejected) console.error(`[ap-client] ${a.name}: ${r}`);
      }
    }
  } catch (err) {
    console.warn(`[ap-client] pair-overrides pass failed: ${err && err.message ? err.message : err}`);
  }

  if (allAgents.length === 0) {
    console.error("[ap-client] ⛔ No agents bootstrapped. The bridge will not connect to any rooms.");
    console.error("[ap-client] Fix one of the entries above, then restart:");
    console.error("[ap-client]   launchctl kickstart -k gui/$(id -u)/com.myclawpassport.bridge");
    console.error("[ap-client] Usage if you're setting up fresh:");
    console.error("[ap-client]   node ap-client.mjs apt_xxx apt_yyy apt_zzz   # multiple agents, one command");
    console.error("[ap-client]   node ap-client.mjs apt_xxx                    # single agent");
    console.error("[ap-client]   AP_TOKENS=apt_xxx,apt_yyy node ap-client.mjs  # env var (comma-separated)");
    console.error('[ap-client]   # or create ap-client.json: { "tokenPairs": [{ "apt": "apt_xxx", "aptr": "aptr_yyy" }] }');
    process.exit(1);
  }

  // B4 startup check — marker: B4_STARTUP_CHECK_CALLED
  assertConfigFileMode600(CONFIG_FILE);
  console.log("[ap-client] PrMaat Client starting");
  console.log(`[ap-client] VPS: ${hostOverride || VPS_HTTP}`);
  console.log(`[ap-client] OpenClaw: ${OPENCLAW_BIN}`);
  console.log(`[ap-client] Agents: ${allAgents.length}`);
  for (const a of allAgents) {
    console.log(`  - ${a.name} (openclaw: ${a.openclawAgent}, rooms: ${a.rooms.length})`);
  }

  for (const agent of allAgents) {
    for (const roomId of agent.rooms) {
      connectAgentRoom(agent, roomId);
      startHeartbeat(agent, roomId, hostOverride);
      startMentionPoll(agent, roomId, hostOverride);
    }
    // Enable self-healing room discovery for every agent. Track 2: the
    // tick re-fetches aps_ via ensureAccessToken each cycle so we don't
    // depend on agent.token (which gets nulled post-migration).
    startSelfHeal(agent, hostOverride);
    // Anti-clone T1.5: auto-rotate apt_ via aptr_ for paired agents.
    if (agent.rotateToken) {
      startAutoRotate(agent, hostOverride);
    }
    // Round 22 follow-up: brain-room R22 vote 3/3 unanimous next priority.
    // Auto-call POST /agent/declare so the covenant agent signature lands
    // seconds after bridge boot, killing the amber "agent signature
    // pending" state on /verify for new mints. Idempotent: re-runs no-op
    // if covenant_agent_signed_at is already on the row.
    ensureAgentDeclared(agent, hostOverride).catch((err) => {
      console.warn(`[${agent.name}] auto-declare error: ${err && err.message ? err.message : err}`);
    });
  }

  // B5 (2026-04-23): startup audit. POST a summary of the effective
  // config (agents × brains × brainBin hashes) to the backend so
  // operators can detect silent drift in the audit chain. Non-blocking,
  // best-effort — a failure here doesn't affect bridge operation.
  postStartupAudit(allAgents, hostOverride).catch((err) => {
    console.warn(`[ap-client] B5 startup audit failed: ${err && err.message ? err.message : err}`);
  });
}

// ── B5 startup audit (2026-04-23) ─────────────────────────────────────
// POSTs /bridges/audit/startup with {agents, bootedAt, hostname,
// bridgeVersion}. brainBinHash is sha256 of the actual binary at boot
// — a future update to the binary produces a different hash in the
// audit chain, giving operators a trail of silent changes.
async function postStartupAudit(agents, hostOverride) {
  const host = hostOverride || VPS_HTTP;
  const base = host.includes(":3100") ? host : `${host}/api`;
  const { createHash } = await import("crypto");
  const os = await import("os");

  function hashBin(path) {
    if (!path || !existsSync(path)) return null;
    try {
      return createHash("sha256").update(readFileSync(path)).digest("hex");
    } catch {
      return null;
    }
  }

  const summary = {
    agents: agents.map((a) => ({
      name: a.name,
      passportId: a.passportId,
      brain: a.brain || null,
      brainBin: a.brainBin || null,
      brainBinHash: hashBin(a.brainBin),
      workingDir: a.workingDir || null,
      openclawAgent: a.openclawAgent || null,
    })),
    bootedAt: new Date().toISOString(),
    bridgeVersion: "2026-04-23-b5",
    hostname: os.hostname(),
    platform: process.platform,
    nodeVersion: process.version,
  };

  // Auth: use the first agent's session token. Any valid passport-token
  // authenticates the endpoint on the backend.
  const first = agents[0];
  if (!first) return;
  const token = await ensureAccessToken(first);
  if (!token) {
    console.warn("[ap-client] B5: no token for startup audit, skipping");
    return;
  }
  const res = await fetch(`${base}/bridges/audit/startup`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(summary),
  });
  if (!res.ok) {
    console.warn(`[ap-client] B5 startup audit HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    return;
  }
  console.log(`[ap-client] B5 startup audit posted (${agents.length} agents, booted ${summary.bootedAt})`);
}

main().catch(err => { console.error("[ap-client] Fatal:", err.message); process.exit(1); });

process.on("SIGINT", () => { console.log("\n[ap-client] shutting down"); process.exit(0); });
process.on("SIGTERM", () => { console.log("\n[ap-client] shutting down"); process.exit(0); });
