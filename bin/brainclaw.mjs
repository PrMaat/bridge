#!/usr/bin/env node
/**
 * brainclaw — PrMaat bridge CLI
 *
 * The user-facing entrypoint that civilians type. Dispatches subcommands
 * to the underlying bridge runtime (ap-client.mjs) and the device-pairing
 * flow.
 *
 * Subcommands:
 *   brainclaw init       Interactive pairing — prompts for the 8-char code
 *                        the creator sees in the web UI, claims it, writes
 *                        ~/.prmaat/ap-client.json with the session.
 *                        (Legacy ~/.myclawpassport/ still read for backward
 *                        compat; auto-migrated forward on first boot.)
 *   brainclaw start      Run the bridge in the foreground (Ctrl-C to stop).
 *   brainclaw status     Check if the bridge is running + last 10 log lines.
 *   brainclaw doctor     Self-diagnostic: node version, config, file perms,
 *                        VPS reachability, token validity + TTL, launchd
 *                        plist, process liveness, log recency. Exits non-zero
 *                        when any check fails so CI / wrappers can gate on it.
 *   brainclaw version    Print version + runtime info.
 *   brainclaw help       Print this help.
 *
 * Env overrides (forwarded to the bridge runtime):
 *   AP_HTTP, AP_WS        VPS endpoints (default https://prmaat.com)
 *   AP_CONFIG             Path to ap-client.json (default ~/.prmaat/ap-client.json)
 *   PRMAAT_HOME           Workspace root (default ~/.prmaat). MYCLAW_HOME alias still respected for backward compat.
 *   OPENCLAW_BIN          OpenClaw CLI path (default /Users/mikebot/.openclaw/bin/openclaw)
 *   AP_TOOLS_ENABLED      Per-agent tool-call allowlist (default off)
 */
import { spawn, execFileSync } from "child_process";
import { createHash } from "crypto";
import { readFileSync, existsSync, mkdirSync, statSync, chmodSync, writeFileSync, renameSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { homedir, hostname } from "os";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
// v0.4.0-rc.1 (Mike directive 2026-05-07, R29 v0.2.1): Verifiable Execution
// Receipts. At init, generate a local Ed25519 keypair; private goes to
// the OS Keychain (macOS) or 0600 file (Linux); public is registered with
// the platform via /api/devices/pair/claim alongside the pairing-code
// claim. Per-message receipts are signed by the local private key in
// ap-client.mjs runtime (see receipts.mjs for the signing primitives).
import { generateDeviceKeypair } from "../receipts.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "..");
const BRIDGE_ENTRY = join(PACKAGE_ROOT, "ap-client.mjs");
const PKG_JSON_PATH = join(PACKAGE_ROOT, "package.json");

// v0.3.9 (Mike directive 2026-05-06, wave 23): canonical home dir is now
// ~/.prmaat. PRMAAT_HOME is the canonical env override; MYCLAW_HOME is
// retained as a legacy alias so existing operator launchd configs (which
// may set MYCLAW_HOME) keep working without edits.
const LEGACY_HOME_DIR = join(homedir(), ".myclawpassport");
const HOME_DIR = process.env.PRMAAT_HOME || process.env.MYCLAW_HOME || join(homedir(), ".prmaat");
const DEFAULT_CONFIG = join(HOME_DIR, "ap-client.json");
const DEFAULT_VPS = process.env.AP_HTTP || "https://prmaat.com";

// First-boot migration: copy legacy ~/.myclawpassport/ contents forward to
// ~/.prmaat/ on first invocation if the new dir doesn't yet exist. This
// is idempotent — once ~/.prmaat exists, we skip. Operator can revert by
// `rm -rf ~/.prmaat` (legacy is left in place untouched).
function migrateLegacyHomeIfNeeded() {
  if (process.env.PRMAAT_HOME || process.env.MYCLAW_HOME) return; // explicit override → skip
  if (existsSync(HOME_DIR)) return; // already migrated or fresh install
  if (!existsSync(LEGACY_HOME_DIR)) return; // nothing to migrate
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    // Use cp -R to preserve perms/structure; macOS + Linux both support it.
    // ESM-safe: execFileSync imported at the top with spawn.
    execFileSync("/bin/cp", ["-R", `${LEGACY_HOME_DIR}/.`, HOME_DIR + "/"], { stdio: "ignore" });
    console.log(`[brainclaw] migrated workspace: ${LEGACY_HOME_DIR} → ${HOME_DIR}`);
    console.log(`[brainclaw]   (legacy directory kept for rollback; remove manually after verifying)`);
  } catch (err) {
    console.warn(`[brainclaw] workspace migration failed (non-fatal, will read from legacy path): ${err.message}`);
  }
}
migrateLegacyHomeIfNeeded();

// ── Step 3 (room vote 2026-04-27 Q1=🅐 unanimous): per-creator isolation ──
// Workspace tree:
//   ~/.prmaat/
//     ap-client.json                     (legacy/shared — kept for backward compat)
//     creators.json                      (registry of all per-creator bridges)
//     creators/<slug>/ap-client.json     (per-creator config)
//     creators/<slug>/<slug>.log         (per-creator daemon log)
// Keychain: service `com.prmaat.bridge.<slug>` per creator (Police's
//   Q1=🅐 vote: process+keychain isolation is the actual security boundary).
//   v0.3.9 (wave 23): renamed from `com.myclawpassport.bridge.<slug>`;
//   read paths fall back to the legacy service for backward compat.
// launchd: `com.prmaat.bridge.<slug>` plist per creator (Q1=🅐).
//   v0.3.9: renamed; legacy `com.myclawpassport.bridge.<slug>` plists are
//   detected and recommended-for-update at `brainclaw bridge list` time.
//
// AP_SHARED_BRIDGE=1 (Q3=🅒 minority compat) reverts to single shared bridge.
const SHARED_BRIDGE_OVERRIDE = process.env.AP_SHARED_BRIDGE === "1";
const CREATORS_DIR = join(HOME_DIR, "creators");
const CREATORS_REGISTRY = join(HOME_DIR, "creators.json");

/** Sanitize a creator id (DID) into a filename-safe slug. Mirrors the
 *  server-side creatorIdToSlug() in src/services/deviceConnect.ts.
 *  v0.3.9: accepts both the legacy `did:myclawpassport:creator:*` prefix
 *  and the new canonical `did:prmaat:creator:*` prefix so existing rooms
 *  and historical creators continue to slug correctly. */
function creatorIdToSlug(creatorId) {
  const tail = String(creatorId || "")
    .replace(/^did:prmaat:creator:/, "")
    .replace(/^did:myclawpassport:creator:/, "");
  return tail.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function creatorWorkspace(slug) { return join(CREATORS_DIR, slug); }
function creatorConfig(slug)    { return join(CREATORS_DIR, slug, "ap-client.json"); }
function creatorPlistLabel(slug){ return `com.prmaat.bridge.${slug}`; }
function creatorPlistPath(slug) { return join(homedir(), "Library", "LaunchAgents", `${creatorPlistLabel(slug)}.plist`); }
function creatorKeychainService(slug) { return `com.prmaat.bridge.${slug}`; }
// v0.3.9 (wave 23): legacy plist label / keychain service for the same
// creator slug. Used for read-path backward compat (e.g., detecting an
// already-installed legacy plist before writing a new one, or reading
// keychain items written under the old service name).
function legacyCreatorPlistLabel(slug)   { return `com.myclawpassport.bridge.${slug}`; }
function legacyCreatorPlistPath(slug)    { return join(homedir(), "Library", "LaunchAgents", `${legacyCreatorPlistLabel(slug)}.plist`); }
function legacyCreatorKeychainService(slug) { return `com.myclawpassport.bridge.${slug}`; }

function ensureCreatorWorkspace(slug, label) {
  const ws = creatorWorkspace(slug);
  if (!existsSync(ws)) mkdirSync(ws, { recursive: true });
  // Update registry
  let reg = {};
  if (existsSync(CREATORS_REGISTRY)) {
    try { reg = JSON.parse(readFileSync(CREATORS_REGISTRY, "utf8")); } catch { reg = {}; }
  }
  if (!reg.creators) reg.creators = {};
  reg.creators[slug] = {
    slug,
    label: label || reg.creators[slug]?.label || slug,
    workspace: ws,
    config: creatorConfig(slug),
    plistLabel: creatorPlistLabel(slug),
    plistPath: creatorPlistPath(slug),
    keychainService: creatorKeychainService(slug),
    addedAt: reg.creators[slug]?.addedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(CREATORS_REGISTRY, JSON.stringify(reg, null, 2), { mode: 0o600 });
  return reg.creators[slug];
}

function readCreatorsRegistry() {
  if (!existsSync(CREATORS_REGISTRY)) return { creators: {} };
  try { return JSON.parse(readFileSync(CREATORS_REGISTRY, "utf8")); } catch { return { creators: {} }; }
}

function readPkg() {
  try { return JSON.parse(readFileSync(PKG_JSON_PATH, "utf8")); } catch { return { version: "0.0.0", name: "@prmaat/bridge" }; }
}

function printHelp() {
  const { name, version } = readPkg();
  console.log(`${name} v${version} — PrMaat bridge CLI

Usage:
  brainclaw <command> [options]

Commands:
  init             Claim a pairing code from the web UI and write a fresh
                   ap-client.json + device session in ~/.prmaat/
  start            Run the bridge (foreground, Ctrl-C to stop)
  status           Check bridge state + recent log output
  doctor           Full self-diagnostic (exits 1 if any check fails)
  keychain <cmd>   Manage apt_/aptr_ stashed in the macOS Keychain
                     stash    — prompts interactively, no plaintext on disk
                     list     — show stashed passports (no secret values)
                     purge    — remove an entry by passportId
                     migrate  — move apt_/aptr_ from ap-client.json to Keychain
  bridge <cmd>     Multi-tenant bridge ops (macOS launchd)
                     init --creator <label>   — scaffold a per-creator
                                                  bridge: isolated workspace
                                                  + launchd plist +
                                                  keychain namespace
                     list                     — list all installed bridges
                     uninstall --creator <l>  — remove a per-creator bridge
  version          Print version + runtime info
  help             This help

Environment:
  AP_HTTP          ${DEFAULT_VPS}
  AP_CONFIG        ${DEFAULT_CONFIG}
  MYCLAW_HOME      ${HOME_DIR}

Quick start:
  1. In the PrMaat web UI, open the passport's Add-Device panel.
  2. Copy the 8-char code (XXXX-XXXX).
  3. Here: brainclaw init      # paste the code when prompted
  4. Here: brainclaw start     # bridge goes live

Paranoid install (no plaintext tokens on disk, macOS only):
  1. brainclaw keychain stash         # paste apt_/aptr_ into Keychain
  2. Write minimal ap-client.json with { tokenPairs: [{ passportId, label }] }
  3. brainclaw start`);
}

function printVersion() {
  const pkg = readPkg();
  console.log(`${pkg.name} v${pkg.version}`);
  console.log(`node ${process.version}`);
  console.log(`platform ${process.platform}/${process.arch}`);
  console.log(`bridge entry ${BRIDGE_ENTRY}`);
  console.log(`config ${DEFAULT_CONFIG}`);
  console.log(`vps ${DEFAULT_VPS}`);
}

function ensureHomeDir() {
  if (!existsSync(HOME_DIR)) {
    mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  }
}

async function cmdStart() {
  if (!existsSync(BRIDGE_ENTRY)) {
    console.error(`[brainclaw] bridge entry not found at ${BRIDGE_ENTRY}`);
    console.error(`[brainclaw] is the package installed correctly?`);
    process.exit(1);
  }
  const configPath = process.env.AP_CONFIG || DEFAULT_CONFIG;
  if (!existsSync(configPath)) {
    console.error(`[brainclaw] no config found at ${configPath}`);
    console.error(`[brainclaw] run  brainclaw init  first to create one.`);
    process.exit(1);
  }
  console.log(`[brainclaw] starting bridge (config=${configPath})`);
  const child = spawn(process.execPath, [BRIDGE_ENTRY], {
    stdio: "inherit",
    env: { ...process.env, AP_CONFIG: configPath },
  });
  child.on("exit", (code, sig) => {
    if (sig) console.log(`[brainclaw] bridge exited via ${sig}`);
    process.exit(code ?? 0);
  });
  // Propagate signals so Ctrl-C works cleanly.
  for (const s of ["SIGINT", "SIGTERM"]) {
    process.on(s, () => { try { child.kill(s); } catch { /* ignore */ } });
  }
}

async function cmdStatus() {
  const logPath = process.env.AP_LOG || join(HOME_DIR, "bridge.log");
  console.log(`[brainclaw] config: ${process.env.AP_CONFIG || DEFAULT_CONFIG}`);
  console.log(`[brainclaw] vps:    ${DEFAULT_VPS}`);
  console.log(`[brainclaw] log:    ${logPath}`);
  if (existsSync(logPath)) {
    const st = statSync(logPath);
    console.log(`[brainclaw] log mtime: ${st.mtime.toISOString()}  size: ${st.size}b`);
  } else {
    console.log(`[brainclaw] (no log file yet — is the bridge running?)`);
  }
  // Best-effort process check on POSIX: look for "ap-client.mjs" in ps output.
  if (process.platform !== "win32") {
    const ps = spawn("/bin/ps", ["-ef"], { stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    ps.stdout.on("data", (d) => { buf += d.toString(); });
    await new Promise((r) => ps.on("close", r));
    const lines = buf.split("\n").filter(l => l.includes("ap-client.mjs") && !l.includes("grep") && !l.includes("brainclaw"));
    if (lines.length === 0) {
      console.log(`[brainclaw] bridge: NOT RUNNING`);
    } else {
      console.log(`[brainclaw] bridge: ${lines.length} process(es) running`);
      for (const l of lines) console.log(`  ${l.trim().slice(0, 140)}`);
    }
  }
}

// Module-level guard so a single CLI flag can disable every prompt the bridge
// would otherwise raise. Set by the dispatcher when --non-interactive is on
// (v0.3.8, Mike directive 2026-05-06). The point is to give AI agents and CI
// runners an honest path: every required value comes from --config or env,
// and if any is missing the bridge fails loudly instead of asking the
// session to "decide" a value it has no business deciding.
let __NON_INTERACTIVE = false;
let __NO_SELF_ATTEST = false;
function setNonInteractive(v) { __NON_INTERACTIVE = !!v; }
function setNoSelfAttest(v) { __NO_SELF_ATTEST = !!v; }
function isNonInteractive() { return __NON_INTERACTIVE; }
function isNoSelfAttest() { return __NO_SELF_ATTEST; }

async function prompt(rl, question, def) {
  // v0.3.8: under --non-interactive, every prompt is a hard error — the
  // operator must supply the answer in --config (or env) ahead of time.
  // The thrown error names the missing field so config files can be
  // patched in one round-trip rather than discovered prompt-by-prompt.
  if (__NON_INTERACTIVE) {
    throw new Error(
      `[brainclaw] --non-interactive mode: required value missing for prompt: "${question}". ` +
      `Add this field to the config file you pass via --config, or unset --non-interactive ` +
      `to use stdin prompts. The bridge intentionally refuses to fall back to defaults under ` +
      `--non-interactive — every attestable value must come from the operator-controlled config.`
    );
  }
  const answer = (await rl.question(def ? `${question} [${def}] ` : `${question} `)).trim();
  return answer || def || "";
}

async function claimPairingCode(code, deviceName, devicePublicKeyPem, deviceKeyId) {
  // v0.4.0-rc.1 (R29 v0.2.1): include devicePublicKey + deviceKeyId in the
  // claim payload so the platform registers them in `device_keys`. Server
  // accepts the new fields; older servers ignore unknown keys (forward-
  // compatible). If the bridge is running against a pre-v0.4 server, the
  // public key is silently dropped — receipts will then verify under
  // legacy_bearer_only mode (graceful degradation).
  const body = JSON.stringify({
    code,
    deviceName: deviceName || null,
    devicePublicKeyPem: devicePublicKeyPem || null,
    deviceKeyId: deviceKeyId || null,
    bridgeVersion: readPkg().version || null,
  });
  const res = await fetch(`${DEFAULT_VPS}/api/devices/pair/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`claim failed: HTTP ${res.status} — ${t.slice(0, 200)}`);
  }
  return res.json();
}

// Fetch the bootstrap summary so we know the agent name, server-selected
// openclaw agent, and available rooms. This hits the apt_-authenticated
// /agent/bootstrap endpoint the bridge uses at runtime too.
async function agentBootstrap(aptToken, devicePublicKeyPem, deviceKeyId) {
  // v0.4.0-rc.1: include device public key in bootstrap so token-mode
  // enrollment also registers a signing key. Older servers ignore the
  // extra fields.
  const body = JSON.stringify({
    devicePublicKeyPem: devicePublicKeyPem || null,
    deviceKeyId: deviceKeyId || null,
    bridgeVersion: readPkg().version || null,
  });
  const res = await fetch(`${DEFAULT_VPS}/agent/bootstrap`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${aptToken}`, "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`bootstrap failed: HTTP ${res.status} — ${t.slice(0, 200)}`);
  }
  return res.json();
}

// v0.4.0-rc.1: stash the device Ed25519 private key. macOS uses the
// login Keychain (service `com.prmaat.bridge.signing`, account=keyId);
// Linux/other writes a 0600 file at ~/.prmaat/keys/<keyId>.pem. The
// public key + keyId travel to the platform; the private key never
// leaves this machine.
function stashDevicePrivateKey(keyId, privateKeyPem) {
  if (process.platform === "darwin") {
    try {
      execFileSync("/usr/bin/security", [
        "add-generic-password",
        "-s", "com.prmaat.bridge.signing",
        "-a", keyId,
        "-w", privateKeyPem,
        "-U", // update if already exists
      ], { stdio: ["ignore", "ignore", "pipe"] });
      return { storage: "macos-keychain", location: `com.prmaat.bridge.signing/${keyId}` };
    } catch (err) {
      // fall through to file storage
      console.warn(`[brainclaw] keychain stash failed (${err.message}) — falling back to 0600 file`);
    }
  }
  const keyDir = join(HOME_DIR, "keys");
  if (!existsSync(keyDir)) mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  const keyPath = join(keyDir, `${keyId}.pem`);
  writeFileSync(keyPath, privateKeyPem, { mode: 0o600 });
  try { chmodSync(keyPath, 0o600); } catch {}
  return { storage: "file", location: keyPath };
}

async function cmdInit() {
  ensureHomeDir();
  const configPath = process.env.AP_CONFIG || DEFAULT_CONFIG;
  console.log(`[brainclaw] PrMaat bridge — init`);
  console.log(`[brainclaw] vps: ${DEFAULT_VPS}\n`);
  console.log(`Two ways to connect this machine:`);
  console.log(`  1) pairing code — the 8-char code from the web UI's Add-Device panel (no token pasted)`);
  console.log(`  2) apt_ token    — the long-lived agent token from the Passports page\n`);

  if (existsSync(configPath)) {
    console.log(`[brainclaw] existing config detected at ${configPath}`);
    const rl0 = createInterface({ input, output });
    const overwrite = (await prompt(rl0, "Overwrite? (y/N)", "N")).toLowerCase();
    rl0.close();
    if (overwrite !== "y" && overwrite !== "yes") {
      console.log(`[brainclaw] aborted. existing config kept.`);
      process.exit(0);
    }
  }

  const rl = createInterface({ input, output });
  const mode = (await prompt(rl, "Mode: [1=code / 2=token]", "1")).trim();
  let cfg;

  if (mode === "1" || mode === "") {
    const code = await prompt(rl, "Pairing code (XXXX-XXXX):");
    if (!code) { rl.close(); console.error(`[brainclaw] no code entered — aborting.`); process.exit(1); }
    const deviceName = await prompt(rl, "Device name (this machine)", process.env.HOSTNAME || "unknown-device");
    rl.close();
    console.log(`[brainclaw] generating device Ed25519 signing keypair...`);
    const kp = generateDeviceKeypair();
    const stash = stashDevicePrivateKey(kp.keyId, kp.privateKeyPem);
    console.log(`[brainclaw] ✓ keypair generated. key_id=${kp.keyId} (${stash.storage})`);
    console.log(`[brainclaw] claiming code + registering public key...`);
    let claim;
    try {
      claim = await claimPairingCode(code.trim(), deviceName.trim(), kp.publicKeyPem, kp.keyId);
    } catch (err) { console.error(`[brainclaw] ${err.message}`); process.exit(1); }
    // Server (post Phase 2.1, 2026-04-19) returns { token, rotateToken, ... }
    // We keep legacy fallbacks (apt, agentToken) for paranoia during rollout.
    const token = claim.token || claim.apt || claim.agentToken || null;
    const rotateToken = claim.rotateToken || null;
    if (!token) {
      console.error(`[brainclaw] ERROR: claim response did not carry an apt_ token.`);
      console.error(`[brainclaw] Keys returned: ${Object.keys(claim).join(", ")}`);
      console.error(`[brainclaw] Server may be running a pre-2026-04-19 build — ask the admin to redeploy.`);
      process.exit(1);
    }
    // Prefer the modern tokenPairs[] format when the server gave us an
    // aptr_ — this unlocks T1.5 auto-rotation so the bridge keeps running
    // past the 7-day apt_ TTL without any manual intervention. Fall back to
    // agents[] for backwards compatibility (aptr_ absent = older server).
    if (rotateToken) {
      cfg = {
        tokenPairs: [{
          label: claim.deviceLabel || deviceName.trim() || "this device",
          passportId: claim.passportId,
          apt: token,
          aptr: rotateToken,
          deviceKeyId: kp.keyId,
          pairedAt: new Date().toISOString(),
        }],
      };
      console.log(`[brainclaw] ✓ received apt_ + aptr_ pair (T1.5 auto-rotation enabled)`);
    } else {
      cfg = {
        agents: [{
          name: claim.agentName || "Agent",
          passportId: claim.passportId,
          token,
          rooms: claim.rooms || [],
        }],
      };
      console.log(`[brainclaw] ✓ received apt_ (legacy shape — T1.5 auto-rotation disabled)`);
    }
  } else if (mode === "2") {
    const token = await prompt(rl, "apt_ token:");
    if (!token || !token.startsWith("apt_")) { rl.close(); console.error(`[brainclaw] token must start with apt_ — aborting.`); process.exit(1); }
    console.log(`[brainclaw] generating device Ed25519 signing keypair...`);
    const kp = generateDeviceKeypair();
    const stash = stashDevicePrivateKey(kp.keyId, kp.privateKeyPem);
    console.log(`[brainclaw] ✓ keypair generated. key_id=${kp.keyId} (${stash.storage})`);
    console.log(`[brainclaw] verifying token + registering public key...`);
    let boot;
    try {
      boot = await agentBootstrap(token.trim(), kp.publicKeyPem, kp.keyId);
    } catch (err) { rl.close(); console.error(`[brainclaw] ${err.message}`); process.exit(1); }
    const rooms = (boot.rooms || []).map((r) => r.id || r).slice(0, 10);
    rl.close();
    cfg = {
      agents: [{
        name: boot.agentName || boot.name || "Agent",
        passportId: boot.passportId,
        token: token.trim(),
        deviceKeyId: kp.keyId,
        openclawAgent: boot.openclawAgent || null,
        rooms,
      }],
    };
  } else {
    rl.close();
    console.error(`[brainclaw] unknown mode: ${mode}`);
    process.exit(1);
  }

  writeFileSync(configPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { chmodSync(configPath, 0o600); } catch { /* already set */ }
  console.log(`\n[brainclaw] ✓ wrote config to ${configPath}`);
  console.log(`[brainclaw] next:  brainclaw start`);
}

// ── doctor: self-diagnostic ──────────────────────────────────────────────
// A fresh install on a new Mac mini hit at least three classes of silent
// failure during the T1.5 rollout:
//   1. Config existed but was mode 644 (world-readable apt_ token).
//   2. apt_ token was valid but already past its rotateSoon threshold,
//      so the first room join worked and then the bridge hard-failed
//      24h later with nobody watching.
//   3. launchd plist was installed but had a typo'd Node path, so
//      `brainclaw status` showed NOT RUNNING and operators reinstalled
//      from scratch instead of noticing the one-line path fix.
//
// `doctor` catches all three before they turn into pages. It is
// side-effect-free — no writes, no rotations, no restarts — just a
// battery of reads + HTTP GETs with human-readable verdicts.
//
// Exit codes:
//   0 — all checks passed (possibly with warnings)
//   1 — at least one check failed
//
// Colour: ANSI only when stdout is a TTY; otherwise stripped so logs
// stay readable in CI / launchd output.

const DOCTOR_MIN_NODE = 18;

function useColor() {
  if (process.env.NO_COLOR) return false;
  return process.stdout.isTTY === true;
}

function tag(level) {
  const color = useColor();
  if (level === "ok") return color ? "\x1b[32m✓\x1b[0m" : "✓";
  if (level === "warn") return color ? "\x1b[33m!\x1b[0m" : "!";
  if (level === "fail") return color ? "\x1b[31m✗\x1b[0m" : "✗";
  return color ? "\x1b[2m·\x1b[0m" : "·";
}

function dim(s) { return useColor() ? `\x1b[2m${s}\x1b[0m` : s; }

function printCheck(level, label, detail, hint) {
  const line = `${tag(level)} ${label}`;
  console.log(detail ? `${line}  ${dim(detail)}` : line);
  if (hint) console.log(`    ${dim("↳ " + hint)}`);
}

async function httpJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, ok: res.ok, json, text };
}

function summariseToken(apt) {
  if (!apt || typeof apt !== "string") return "(missing)";
  return `${apt.slice(0, 10)}…${apt.slice(-4)} (${apt.length}ch)`;
}

async function cmdDoctor() {
  console.log(`brainclaw doctor — PrMaat bridge diagnostic\n`);
  let failures = 0;
  let warnings = 0;

  // ── Runtime ──
  const nodeMajor = parseInt((process.versions.node || "0").split(".")[0], 10);
  if (nodeMajor >= DOCTOR_MIN_NODE) {
    printCheck("ok", `node ${process.version}`, `>= ${DOCTOR_MIN_NODE}`);
  } else {
    failures++;
    printCheck("fail", `node ${process.version}`, `expected >= ${DOCTOR_MIN_NODE}`,
      `Upgrade node: brew install node (or use nvm).`);
  }
  printCheck("ok", `platform ${process.platform}/${process.arch}`);

  // ── Config file ──
  const configPath = process.env.AP_CONFIG || DEFAULT_CONFIG;
  let cfg = null;
  let cfgRaw = null;
  if (!existsSync(configPath)) {
    failures++;
    printCheck("fail", `config at ${configPath}`, "not found",
      `Run  brainclaw init  to create one.`);
  } else {
    printCheck("ok", `config at ${configPath}`, `${statSync(configPath).size} bytes`);
    // Permissions: must NOT be world- or group-readable on POSIX.
    if (process.platform !== "win32") {
      const mode = statSync(configPath).mode & 0o777;
      const octal = mode.toString(8).padStart(3, "0");
      if (mode & 0o077) {
        warnings++;
        printCheck("warn", `config permissions`, `mode ${octal}`,
          `Tighten: chmod 600 ${configPath}  (token is group/world-readable).`);
      } else {
        printCheck("ok", `config permissions`, `mode ${octal}`);
      }
    }
    // Parse.
    try {
      cfgRaw = readFileSync(configPath, "utf8");
      cfg = JSON.parse(cfgRaw);
      printCheck("ok", `config parses as JSON`);
    } catch (err) {
      failures++;
      printCheck("fail", `config JSON parse`, err.message,
        `Re-create: brainclaw init  (backup first if the file has edits).`);
    }
  }

  // ── Credential shape ──
  let tokenPairs = [];  // T1.5 shape
  let legacyAgents = [];
  if (cfg) {
    if (Array.isArray(cfg.tokenPairs) && cfg.tokenPairs.length) {
      tokenPairs = cfg.tokenPairs;
      printCheck("ok", `credential shape`, `tokenPairs[] (T1.5 — ${tokenPairs.length} pair${tokenPairs.length === 1 ? "" : "s"})`);
    } else if (Array.isArray(cfg.agents) && cfg.agents.length) {
      legacyAgents = cfg.agents;
      warnings++;
      printCheck("warn", `credential shape`, `legacy agents[] (${legacyAgents.length})`,
        `T1.5 auto-rotate disabled. Re-pair to upgrade: brainclaw init.`);
    } else if (Array.isArray(cfg.tokens) && cfg.tokens.length) {
      // Very old flat token list — not recommended, no rotation, no label.
      legacyAgents = cfg.tokens.map((t, i) => ({ name: `token-${i}`, token: t }));
      warnings++;
      printCheck("warn", `credential shape`, `very-legacy tokens[] (${legacyAgents.length})`,
        `Re-pair with brainclaw init to get the modern tokenPairs shape.`);
    } else {
      failures++;
      printCheck("fail", `credential shape`, "no tokens found in config",
        `Run  brainclaw init  to pair this device.`);
    }
  }

  // ── VPS reachability ──
  const vps = DEFAULT_VPS;
  try {
    const r = await httpJson(`${vps}/api/healthz`);
    if (r.ok) {
      printCheck("ok", `VPS reachable`, `${vps} → HTTP ${r.status}`);
    } else {
      // /api/healthz may 404 on old servers — fall back to any 2xx/3xx.
      const r2 = await httpJson(vps);
      if (r2.status < 500) {
        printCheck("ok", `VPS reachable`, `${vps} → HTTP ${r2.status} (no /api/healthz)`);
      } else {
        failures++;
        printCheck("fail", `VPS reachable`, `HTTP ${r.status} at ${vps}`,
          `Check DNS + firewall + SSL: curl -v ${vps}`);
      }
    }
  } catch (err) {
    failures++;
    printCheck("fail", `VPS reachable`, err.message,
      `Offline? VPN? DNS? Try: ping prmaat.com`);
  }

  // ── Per-token checks (apt_ live + TTL) ──
  const checks = tokenPairs.length
    ? tokenPairs.map((p) => ({ label: p.label || p.passportId || "?", apt: p.apt, aptr: p.aptr, passportId: p.passportId }))
    : legacyAgents.map((a) => ({ label: a.name || "?", apt: a.token, aptr: null, passportId: a.passportId || null }));

  for (const ck of checks) {
    const header = `token [${ck.label}]`;
    // If the file has no apt_, there are three legitimate cases before we
    // call it a failure:
    //   (a) Track 2 post-purge — apt null, passportId present, bridge runs
    //       on aps_/apr_ from keychain (the common case on a mature install)
    //   (b) Paranoid install — apt stashed in Keychain under apt-<hash>
    //   (c) Neither — genuinely broken, operator needs to re-pair
    if (!ck.apt || !ck.apt.startsWith("apt_")) {
      let stashedApt = null;
      if (process.platform === "darwin" && ck.passportId) {
        stashedApt = await keychainGet(aptAccount(ck.passportId));
      }
      if (stashedApt && stashedApt.startsWith("apt_")) {
        ck.apt = stashedApt;                // upgrade for subsequent checks
        printCheck("ok", header, `${summariseToken(stashedApt)} (Keychain)`);
      } else if (ck.passportId) {
        // Track 2 post-purge — defer verdict to the session-hydration check.
        // Bridge is expected to run on aps_ without ever touching apt_ again.
        printCheck("ok", header, "apt purged (Track 2 — bridge runs on aps_)");
        const stashedAptr = process.platform === "darwin" ? await keychainGet(aptrAccount(ck.passportId)) : null;
        if (stashedAptr && stashedAptr.startsWith("aptr_")) {
          printCheck("ok", `  ↳ rotate scope (aptr_)`, "in Keychain");
        }
        continue;
      } else {
        failures++;
        printCheck("fail", header, "no apt_ value and no passportId",
          `Re-pair this agent: brainclaw init`);
        continue;
      }
    } else {
      printCheck("ok", header, summariseToken(ck.apt));
    }
    // Bootstrap — cheapest apt_-authenticated endpoint we have.
    // It's a GET (not POST) — confirmed against src/routes/agent.ts.
    try {
      const r = await httpJson(`${vps}/agent/bootstrap`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${ck.apt}` },
      });
      if (r.ok) {
        const name = r.json?.agentName || r.json?.name || "(unnamed)";
        printCheck("ok", `  ↳ /agent/bootstrap`, `200 → ${name}`);
      } else if (r.status === 401) {
        failures++;
        const reason = r.json?.error || r.text.slice(0, 80);
        printCheck("fail", `  ↳ /agent/bootstrap`, `401 — ${reason}`,
          `Token invalid/revoked/expired. Re-pair: brainclaw init`);
      } else if (r.status === 403) {
        failures++;
        printCheck("fail", `  ↳ /agent/bootstrap`, `403`,
          `Token bound to a different origin or passport deactivated.`);
      } else {
        warnings++;
        printCheck("warn", `  ↳ /agent/bootstrap`, `HTTP ${r.status}`,
          `Unexpected status — server may be mid-deploy.`);
      }
    } catch (err) {
      failures++;
      printCheck("fail", `  ↳ /agent/bootstrap`, err.message);
    }
    // Token TTL — rotation signal.
    if (ck.passportId) {
      try {
        const r = await httpJson(`${vps}/api/passports/${encodeURIComponent(ck.passportId)}/token-ttl`, {
          headers: { "Authorization": `Bearer ${ck.apt}` },
        });
        if (r.ok && r.json) {
          // The server returns `expiresInSeconds` (not `secondsUntilExpiry`) —
          // keep both names as a fallback for mid-rollout version skew.
          const { expiresAt, rotateSoon, expired } = r.json;
          const secs = r.json.expiresInSeconds ?? r.json.secondsUntilExpiry ?? null;
          const human = expiresAt
            ? `expires ${new Date(expiresAt).toISOString()} (${secs == null ? "?" : Math.round(secs / 3600)}h)`
            : "no expiry (grandfathered)";
          if (expired) {
            failures++;
            printCheck("fail", `  ↳ token TTL`, "expired",
              `Rotate now: use the aptr_ to POST /api/passports/${ck.passportId}/regenerate-token`);
          } else if (rotateSoon) {
            warnings++;
            printCheck("warn", `  ↳ token TTL`, human,
              ck.aptr ? `Bridge auto-rotates at next poll.` : `No aptr_ stored — rotate manually soon.`);
          } else {
            printCheck("ok", `  ↳ token TTL`, human);
          }
        } else {
          printCheck("warn", `  ↳ token TTL`, `HTTP ${r.status}`);
          warnings++;
        }
      } catch (err) {
        warnings++;
        printCheck("warn", `  ↳ token TTL`, err.message);
      }
    }
    // aptr_ presence — required for T1.5 auto-rotate.
    if (tokenPairs.length) {
      if (ck.aptr && ck.aptr.startsWith("aptr_")) {
        printCheck("ok", `  ↳ rotate scope (aptr_)`, summariseToken(ck.aptr));
      } else {
        // Item #12 (2026-04-19): aptr_ may be absent from the file but
        // still present in Keychain under account=aptr-<hash24>. Only
        // warn when it's missing from BOTH sources.
        let stashedAptr = null;
        if (process.platform === "darwin" && ck.passportId) {
          stashedAptr = await keychainGet(aptrAccount(ck.passportId));
        }
        if (stashedAptr && stashedAptr.startsWith("aptr_")) {
          printCheck("ok", `  ↳ rotate scope (aptr_)`, "in Keychain");
        } else {
          warnings++;
          printCheck("warn", `  ↳ rotate scope (aptr_)`, "missing",
            `Bridge will keep running but won't auto-rotate. Re-pair or run  brainclaw keychain stash`);
        }
      }
    }
    // Item #12: also surface stashed apt_ when the file has no apt_ but
    // the keychain does — operator should know the paranoid path is active.
    if (process.platform === "darwin" && (!ck.apt || !ck.apt.startsWith("apt_")) && ck.passportId) {
      const stashedApt = await keychainGet(aptAccount(ck.passportId));
      if (stashedApt && stashedApt.startsWith("apt_")) {
        printCheck("ok", `  ↳ keychain stash`, "apt_ in Keychain (paranoid install)");
      }
    }
  }

  // ── launchd plist (macOS only) ──
  if (process.platform === "darwin") {
    // v0.3.9: check both new and legacy plist names. Existing operator
    // installs may still have plists under the old name; the doctor
    // should find them so it can report them and recommend re-running
    // `brainclaw bridge connect` to install the renamed plist.
    const plistCandidates = [
      join(homedir(), "Library/LaunchAgents/com.prmaat.bridge.plist"),
      "/Library/LaunchDaemons/com.prmaat.bridge.plist",
      join(homedir(), "Library/LaunchAgents/com.myclawpassport.bridge.plist"),
      "/Library/LaunchDaemons/com.myclawpassport.bridge.plist",
    ];
    const found = plistCandidates.find((p) => existsSync(p));
    if (found) {
      printCheck("ok", `launchd plist`, found);
    } else {
      warnings++;
      printCheck("warn", `launchd plist`, "not installed",
        `Optional. Install to auto-start on login: see install.sh.`);
    }
  }

  // ── Bridge process liveness ──
  if (process.platform !== "win32") {
    try {
      const ps = spawn("/bin/ps", ["-ef"], { stdio: ["ignore", "pipe", "ignore"] });
      let buf = "";
      ps.stdout.on("data", (d) => { buf += d.toString(); });
      await new Promise((r) => ps.on("close", r));
      const lines = buf.split("\n").filter(l =>
        l.includes("ap-client.mjs") && !l.includes("grep") && !l.includes("brainclaw"));
      if (lines.length === 0) {
        warnings++;
        printCheck("warn", `bridge process`, "not running",
          `Start: brainclaw start  (or  launchctl load  the plist).`);
      } else {
        printCheck("ok", `bridge process`, `${lines.length} process${lines.length === 1 ? "" : "es"} alive`);
      }
    } catch {
      // ps unavailable — skip silently.
    }
  }

  // ── Log recency ──
  const logPath = process.env.AP_LOG || join(HOME_DIR, "bridge.log");
  if (existsSync(logPath)) {
    const st = statSync(logPath);
    const ageMin = (Date.now() - st.mtime.getTime()) / 60000;
    if (ageMin < 10) {
      printCheck("ok", `bridge log`, `${logPath} (${Math.round(ageMin)}m old, ${st.size}b)`);
    } else {
      warnings++;
      printCheck("warn", `bridge log`, `${logPath} (${Math.round(ageMin)}m since last write)`,
        `Bridge may be idle or stuck. Check: tail -20 ${logPath}`);
    }
  } else {
    warnings++;
    printCheck("warn", `bridge log`, "no log file yet");
  }

  // ── Summary ──
  console.log("");
  if (failures === 0 && warnings === 0) {
    console.log(`${tag("ok")} all checks passed`);
    process.exit(0);
  }
  if (failures === 0) {
    console.log(`${tag("warn")} ${warnings} warning${warnings === 1 ? "" : "s"} — bridge should still work`);
    process.exit(0);
  }
  console.log(`${tag("fail")} ${failures} failure${failures === 1 ? "" : "s"}, ${warnings} warning${warnings === 1 ? "" : "s"}`);
  process.exit(1);
}

// ── keychain: OS-keyring stash for apt_/aptr_ bootstrap secrets ─────────
// SWOT item #12 (2026-04-19). Lets operators install the bridge without
// ever writing apt_/aptr_ to a plaintext file. Matches the same
// service+account scheme used by ap-client.mjs runtime
//   service = com.prmaat.bridge   (v0.3.9 canonical, was com.myclawpassport.bridge)
//   account = "apt-<hash24>"  or  "aptr-<hash24>"  where <hash24> is
//             sha256(passportId).slice(0,24). This keeps the passport DID
//             out of `security dump-keychain` screenshots while staying
//             trivially greppable.
// Non-macOS is a no-op with a clear error — the runtime only enables the
// Keychain path on darwin anyway.
// Keychain namespace — matches the ap-client.mjs default. Operators
// running a bridge-per-creator setup (2026-04-23) set AP_KEYCHAIN_SERVICE
// so `brainclaw keychain stash` writes into the right creator bucket.
// The `brainclaw bridge init --creator <label>` command wraps this for
// you by exporting AP_KEYCHAIN_SERVICE before calling keychain stash.
// v0.3.9 (Mike directive 2026-05-06): default service renamed to
// com.prmaat.bridge. ap-client.mjs runtime falls back to the legacy
// com.myclawpassport.bridge service on read for existing keychains.
const KEYCHAIN_SERVICE = process.env.AP_KEYCHAIN_SERVICE || "com.prmaat.bridge";

function keychainHash(passportId) {
  return createHash("sha256").update(String(passportId)).digest("hex").slice(0, 24);
}
function aptAccount(passportId) { return "apt-" + keychainHash(passportId); }
function aptrAccount(passportId) { return "aptr-" + keychainHash(passportId); }

function ensureMacOS() {
  if (process.platform !== "darwin") {
    console.error(`[brainclaw] 'keychain' subcommand is macOS-only (platform=${process.platform}).`);
    console.error(`[brainclaw] On Linux/Windows, store tokens in ~/.prmaat/ap-client.json (mode 600).`);
    process.exit(2);
  }
}

function runSecurity(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/security", args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => resolve({ code, stdout: out.trim(), stderr: err.trim() }));
    child.on("error", (e) => resolve({ code: -1, stdout: "", stderr: e.message }));
  });
}

async function keychainSet(account, value, serviceOverride) {
  // -U updates if existing; retry with explicit delete+add for older
  // security(1) versions where -U is flaky.
  // Step 3 (room vote 2026-04-27 Q1=🅐): serviceOverride lets per-creator
  // namespaces (com.myclawpassport.bridge.<slug>) be used independently of
  // the shared default service.
  const svc = serviceOverride || KEYCHAIN_SERVICE;
  const r = await runSecurity([
    "add-generic-password", "-U", "-s", svc, "-a", account, "-w", value,
  ]);
  if (r.code === 0) return true;
  await runSecurity(["delete-generic-password", "-s", svc, "-a", account]);
  const r2 = await runSecurity([
    "add-generic-password", "-s", svc, "-a", account, "-w", value,
  ]);
  if (r2.code === 0) return true;
  console.error(`[brainclaw] keychain set failed: ${r2.stderr || r.stderr}`);
  return false;
}

async function keychainGet(account, serviceOverride) {
  const svc = serviceOverride || KEYCHAIN_SERVICE;
  const r = await runSecurity([
    "find-generic-password", "-s", svc, "-a", account, "-w",
  ]);
  if (r.code !== 0) return null;
  return r.stdout;
}

async function keychainDelete(account, serviceOverride) {
  const svc = serviceOverride || KEYCHAIN_SERVICE;
  const r = await runSecurity([
    "delete-generic-password", "-s", svc, "-a", account,
  ]);
  return r.code === 0;
}

// List all accounts under our service. The `security dump-keychain` path
// requires Full Disk Access; instead we use `find-generic-password -s` in
// a loop over known passports. To enumerate without knowing DIDs up-front,
// we parse `security find-generic-password -s <svc> -g` output — but
// that only returns ONE. So we take a different route: only list the
// entries that match passports present in ap-client.json. That's the
// useful set 99% of the time anyway.
async function listKeychainForConfig(cfg) {
  const out = [];
  const pairs = Array.isArray(cfg?.tokenPairs) ? cfg.tokenPairs : [];
  for (const p of pairs) {
    if (!p?.passportId) continue;
    const apt = await keychainGet(aptAccount(p.passportId));
    const aptr = await keychainGet(aptrAccount(p.passportId));
    // Does the pair have the Track-2 purge marker? If so, apt_/aptr_
    // being absent from both file and Keychain is the *correct* steady
    // state — the bridge runs on aps_ session tokens stored under a
    // different account ("sess-<hash>"), outside this listing's scope.
    const postPurge = !!p.purgedAt || p.migration === "track-2:keychain";
    out.push({
      passportId: p.passportId,
      label: p.label || null,
      aptStashed: !!apt,
      aptrStashed: !!aptr,
      fileApt: !!p.apt,
      fileAptr: !!p.aptr,
      postPurge,
    });
  }
  return out;
}

async function cmdKeychain(rest) {
  ensureMacOS();
  const sub = rest[0];
  const configPath = process.env.AP_CONFIG || DEFAULT_CONFIG;

  if (!sub || sub === "help") {
    console.log(`brainclaw keychain — manage apt_/aptr_ in macOS Keychain

Subcommands:
  stash               Prompt for passportId + apt_ (+ aptr_) and store them
  list                Show stashed entries for passports listed in config
  purge <passportId>  Remove the apt_/aptr_ for one passport
  migrate             Move apt_/aptr_ from ${configPath} to Keychain
                      (file keeps passportId+label so bridge still finds them)

Keychain storage:
  service = ${KEYCHAIN_SERVICE}
  account = "apt-<h>" or "aptr-<h>"  where <h> = sha256(passportId).slice(0,24)`);
    return;
  }

  if (sub === "stash") {
    const rl = createInterface({ input, output });
    const passportId = (await prompt(rl, "passportId (did:prmaat:... or legacy did:myclawpassport:...):")).trim();
    // v0.3.9: accept both the new canonical did:prmaat: prefix and the
    // legacy did:myclawpassport: prefix. Existing passports minted under
    // the old DID method (immutable per W3C) must continue to stash.
    if (!passportId.startsWith("did:prmaat:") && !passportId.startsWith("did:myclawpassport:")) {
      rl.close();
      console.error(`[brainclaw] passportId must start with did:prmaat: (or legacy did:myclawpassport:)`);
      process.exit(1);
    }
    const apt = (await prompt(rl, "apt_ token:")).trim();
    if (!apt.startsWith("apt_")) {
      rl.close();
      console.error(`[brainclaw] apt token must start with apt_`);
      process.exit(1);
    }
    const aptrRaw = (await prompt(rl, "aptr_ rotate-scoped token (optional, enter to skip):")).trim();
    const aptr = aptrRaw && aptrRaw.startsWith("aptr_") ? aptrRaw : null;
    rl.close();
    const ok = await keychainSet(aptAccount(passportId), apt);
    if (!ok) { console.error(`[brainclaw] failed to stash apt_`); process.exit(1); }
    console.log(`[brainclaw] ✓ apt_ stashed under account=${aptAccount(passportId)}`);
    if (aptr) {
      const ok2 = await keychainSet(aptrAccount(passportId), aptr);
      if (ok2) console.log(`[brainclaw] ✓ aptr_ stashed under account=${aptrAccount(passportId)}`);
      else console.warn(`[brainclaw] ! aptr_ stash failed — apt_ saved anyway, T1.5 auto-rotate disabled`);
    } else {
      console.warn(`[brainclaw] ! no aptr_ provided — bridge cannot auto-rotate after TTL expires`);
    }
    console.log(`\nNext: ensure ${configPath} contains this passport so the bridge hydrates it.`);
    console.log(`Example minimal stub:`);
    console.log(`  { "tokenPairs": [{ "passportId": "${passportId}", "label": "this device" }] }`);
    return;
  }

  if (sub === "list") {
    if (!existsSync(configPath)) {
      console.error(`[brainclaw] no config at ${configPath} — nothing to list against.`);
      process.exit(1);
    }
    let cfg = null;
    try { cfg = JSON.parse(readFileSync(configPath, "utf8")); }
    catch (err) { console.error(`[brainclaw] config parse failed: ${err.message}`); process.exit(1); }
    const rows = await listKeychainForConfig(cfg);
    if (rows.length === 0) {
      console.log(`[brainclaw] config has no tokenPairs — nothing to list.`);
      return;
    }
    console.log(`[brainclaw] Keychain entries for ${rows.length} passport(s) (service=${KEYCHAIN_SERVICE}):\n`);
    for (const r of rows) {
      const aptBadge = r.aptStashed
        ? "apt:keychain"
        : r.fileApt
          ? "apt:file"
          : r.postPurge
            ? "apt:aps_(Track2)"
            : "apt:MISSING";
      const aptrBadge = r.aptrStashed
        ? "aptr:keychain"
        : r.fileAptr
          ? "aptr:file"
          : r.postPurge
            ? "aptr:aps_(Track2)"
            : "aptr:-";
      console.log(`  ${r.label || "(unnamed)"}  ${r.passportId}`);
      console.log(`    ${aptBadge}  ${aptrBadge}`);
    }
    return;
  }

  if (sub === "purge") {
    const passportId = rest[1];
    // v0.3.9: accept both did:prmaat: and legacy did:myclawpassport: prefixes.
    if (!passportId || (!passportId.startsWith("did:prmaat:") && !passportId.startsWith("did:myclawpassport:"))) {
      console.error(`[brainclaw] usage: brainclaw keychain purge did:prmaat:...  (or legacy did:myclawpassport:...)`);
      process.exit(2);
    }
    const a = await keychainDelete(aptAccount(passportId));
    const b = await keychainDelete(aptrAccount(passportId));
    console.log(`[brainclaw] ${a ? "✓" : "·"} apt_ purged   ${b ? "✓" : "·"} aptr_ purged  (${passportId})`);
    return;
  }

  if (sub === "migrate") {
    if (!existsSync(configPath)) {
      console.error(`[brainclaw] no config at ${configPath} — nothing to migrate.`);
      process.exit(1);
    }
    let cfg = null;
    try { cfg = JSON.parse(readFileSync(configPath, "utf8")); }
    catch (err) { console.error(`[brainclaw] config parse failed: ${err.message}`); process.exit(1); }
    if (!Array.isArray(cfg.tokenPairs) || cfg.tokenPairs.length === 0) {
      console.error(`[brainclaw] config has no tokenPairs — migrate only supports the T1.5 shape.`);
      console.error(`[brainclaw] Re-pair first: brainclaw init`);
      process.exit(1);
    }
    let moved = 0, skipped = 0, failed = 0;
    for (const p of cfg.tokenPairs) {
      if (!p?.passportId) { skipped++; continue; }
      if (!p.apt && !p.aptr) { skipped++; continue; }  // already migrated
      if (p.apt && p.apt.startsWith("apt_")) {
        const ok = await keychainSet(aptAccount(p.passportId), p.apt);
        if (ok) { p.apt = null; moved++; }
        else { failed++; continue; }
      }
      if (p.aptr && p.aptr.startsWith("aptr_")) {
        const ok = await keychainSet(aptrAccount(p.passportId), p.aptr);
        if (ok) p.aptr = null;
        // aptr failure is soft — apt already saved, bridge still boots.
      }
      p.migratedToKeychainAt = new Date().toISOString();
    }
    // Atomic file swap with tight perms.
    const tmp = `${configPath}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch {}
    renameSync(tmp, configPath);
    console.log(`[brainclaw] migration done — moved: ${moved}, skipped: ${skipped}, failed: ${failed}`);
    if (failed) process.exit(1);
    console.log(`[brainclaw] ✓ ${configPath} no longer contains plaintext apt_/aptr_ (keychain holds them now)`);
    return;
  }

  console.error(`[brainclaw] unknown keychain subcommand: ${sub}`);
  process.exit(2);
}

// ── Bridge-per-creator (2026-04-23, voted unanimous) ───────────────────
// Installing a second bridge for a different creator is three pieces:
//   1. An isolated workspace dir (ap-client.mjs + ap-client.json + logs
//      live in ~/ap-client-<label>/ instead of ~/.myclawpassport/ or
//      ~/ap-client/). Prevents accidental cross-creator config edits.
//   2. An isolated launchd plist (com.myclawpassport.bridge.<label>) with
//      AP_CONFIG, AP_KEYCHAIN_SERVICE, stdout/stderr all pointing into
//      the per-creator workspace. Launchd enforces process isolation.
//   3. An isolated keychain bucket — AP_KEYCHAIN_SERVICE = com.myclaw
//      passport.bridge.<label> so apt_/aptr_/aps_ for this creator never
//      mix with the main bridge's stash.

function bridgeWorkspace(label) {
  return join(homedir(), `ap-client-${label}`);
}
// v0.3.9 (Mike directive 2026-05-06, wave 23): plist + keychain service
// names renamed `com.myclawpassport.bridge.<label>` → `com.prmaat.bridge.<label>`.
// New per-creator bridges write to the new names; existing bridges keep
// running under their old plist label (launchd has no in-place rename).
// Operators rerun `brainclaw bridge connect <label>` to migrate to the
// new name — that bootout's the legacy plist and installs the renamed one.
function bridgePlistPath(label) {
  return join(homedir(), "Library/LaunchAgents", `com.prmaat.bridge.${label}.plist`);
}
function bridgeServiceName(label) {
  return `com.prmaat.bridge.${label}`;
}
function bridgeKeychainService(label) {
  return `com.prmaat.bridge.${label}`;
}
// Legacy variants — used by the bridge connect/list commands to detect
// already-installed bridges under the old name and offer a migration.
function legacyBridgePlistPath(label) {
  return join(homedir(), "Library/LaunchAgents", `com.myclawpassport.bridge.${label}.plist`);
}
function legacyBridgeServiceName(label) {
  return `com.myclawpassport.bridge.${label}`;
}

function normalizeBridgeLabel(raw) {
  if (!raw || typeof raw !== "string") return null;
  // Creators are often identified by email — strip domain + lowercase +
  // replace non-slug chars. `infos@terdegypt.com` → `terdegypt`, etc.
  // Passport DIDs end up as the slug suffix in e.g.
  // `did:myclawpassport:creator:I-8tiH...` → `i-8tih`.
  let s = raw.trim().toLowerCase();
  if (s.includes("@")) s = s.split("@")[1].split(".")[0] || s.split("@")[0];
  if (s.includes(":")) s = s.split(":").pop() || s;
  s = s.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!s || s.length > 64) return null;
  return s;
}

async function cmdBridgeInit(rest) {
  ensureMacOS();
  // Parse --creator <label>
  const i = rest.indexOf("--creator");
  const rawCreator = i >= 0 ? rest[i + 1] : null;
  const label = normalizeBridgeLabel(rawCreator);
  if (!label) {
    console.error("[brainclaw] usage: brainclaw bridge init --creator <label-or-email>");
    console.error("[brainclaw] label must be lowercase alphanumeric + hyphens, ≤64 chars");
    process.exit(2);
  }

  const workspace = bridgeWorkspace(label);
  const plist = bridgePlistPath(label);
  const service = bridgeServiceName(label);
  const keychainSvc = bridgeKeychainService(label);

  if (existsSync(workspace)) {
    console.error(`[brainclaw] workspace already exists: ${workspace}`);
    console.error(`[brainclaw] remove it (or use 'brainclaw bridge uninstall --creator ${label}') and retry`);
    process.exit(2);
  }

  console.log(`[brainclaw] Installing bridge for creator '${label}'`);
  console.log(`[brainclaw]   Workspace: ${workspace}`);
  console.log(`[brainclaw]   Service:   ${service}`);
  console.log(`[brainclaw]   Keychain:  ${keychainSvc}`);

  // 1. Workspace dir (0700 — only the owner should see config + logs)
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  chmodSync(workspace, 0o700);

  // 2. Starter ap-client.json. PassportIds get added when the operator
  //    runs `brainclaw keychain stash` — we write a skeleton here so the
  //    bridge doesn't fail on missing file. File mode 0600 is enforced by
  //    ap-client.mjs's B4 startup check.
  const cfgPath = join(workspace, "ap-client.json");
  writeFileSync(cfgPath, JSON.stringify({
    _comment: `bridge-per-creator workspace for '${label}' — created by 'brainclaw bridge init' on ${new Date().toISOString()}. Add passport DIDs to the tokenPairs array below, then run 'AP_KEYCHAIN_SERVICE=${keychainSvc} brainclaw keychain stash' to register apt_/aptr_ in the isolated keychain bucket.`,
    tokenPairs: [],
  }, null, 2));
  chmodSync(cfgPath, 0o600);

  // 3. Launchd plist. We keep the ap-client.mjs binary location as the
  //    CANONICAL install path (same binary, different config). Each
  //    bridge process reads its own AP_CONFIG + AP_KEYCHAIN_SERVICE.
  const nodeBin = process.env.NODE_BIN || "/opt/homebrew/bin/node";
  const apClientMjs = process.env.AP_CLIENT_MJS || BRIDGE_ENTRY;
  const logPath = join(workspace, "ap-client.log");
  const plistBody = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTD/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${service}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${apClientMjs}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${workspace}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>AP_CONFIG</key>
    <string>${cfgPath}</string>
    <key>AP_KEYCHAIN_SERVICE</key>
    <string>${keychainSvc}</string>
    <key>AP_SESSIONS_PATH</key>
    <string>${join(workspace, ".ap-sessions.json")}</string>
  </dict>
</dict>
</plist>
`;
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, plistBody);
  console.log(`[brainclaw] ✓ wrote plist: ${plist}`);

  // 4. Print the post-install checklist — NOT auto-run. Operator has to
  //    stash tokens + bootstrap the service explicitly so they know what
  //    just happened.
  console.log("");
  console.log("[brainclaw] ────────────────────────────────────────────────");
  console.log("[brainclaw] Next steps (manual, one-time):");
  console.log("[brainclaw]");
  console.log(`[brainclaw] 1. Add one entry per passport to ${cfgPath}`);
  console.log(`[brainclaw]    tokenPairs: [{ passportId, label }] — no apt_/aptr_ on disk.`);
  console.log("[brainclaw]");
  console.log("[brainclaw] 2. Stash each passport's apt_ + aptr_ into the isolated keychain:");
  console.log(`[brainclaw]    AP_KEYCHAIN_SERVICE=${keychainSvc} brainclaw keychain stash`);
  console.log("[brainclaw]");
  console.log("[brainclaw] 3. Load the launchd service:");
  console.log(`[brainclaw]    launchctl bootstrap gui/$(id -u) ${plist}`);
  console.log("[brainclaw]");
  console.log("[brainclaw] 4. Verify:");
  console.log(`[brainclaw]    launchctl list | grep ${service}`);
  console.log(`[brainclaw]    tail -f ${logPath}`);
  console.log("[brainclaw] ────────────────────────────────────────────────");
}

async function cmdBridgeList(_rest) {
  ensureMacOS();
  const laDir = join(homedir(), "Library/LaunchAgents");
  let entries = [];
  try {
    const { readdirSync } = await import("fs");
    entries = readdirSync(laDir).filter((f) => /^com\.myclawpassport\.bridge(\.[a-z0-9-]+)?\.plist$/.test(f));
  } catch {
    console.error("[brainclaw] cannot read ~/Library/LaunchAgents");
    process.exit(1);
  }
  if (entries.length === 0) {
    console.log("[brainclaw] (no bridges installed)");
    return;
  }
  console.log(`[brainclaw] Installed bridges (${entries.length}):`);
  for (const f of entries) {
    const m = f.match(/^com\.myclawpassport\.bridge(?:\.([a-z0-9-]+))?\.plist$/);
    const label = m?.[1] || "(main)";
    const service = m?.[1] ? `com.myclawpassport.bridge.${m[1]}` : "com.myclawpassport.bridge";
    const workspace = m?.[1] ? bridgeWorkspace(m[1]) : "~/.myclawpassport OR ~/ap-client";
    // Check launchctl state
    const lc = await runSecurity([]);  // just a no-op to reuse resolve pattern — we actually want child_process
    // Use a light shell call instead:
    const { spawnSync } = await import("child_process");
    const res = spawnSync("launchctl", ["list", service], { encoding: "utf8" });
    const running = res.status === 0;
    console.log(`  - ${label.padEnd(20)} service=${service} ${running ? "[running]" : "[not loaded]"}`);
    console.log(`      workspace: ${workspace}`);
  }
}

async function cmdBridgeUninstall(rest) {
  ensureMacOS();
  const i = rest.indexOf("--creator");
  const rawCreator = i >= 0 ? rest[i + 1] : null;
  const label = normalizeBridgeLabel(rawCreator);
  if (!label) {
    console.error("[brainclaw] usage: brainclaw bridge uninstall --creator <label>");
    process.exit(2);
  }
  if (label === "main") {
    console.error("[brainclaw] refusing to uninstall the 'main' bridge via this command — remove its plist manually");
    process.exit(2);
  }
  const plist = bridgePlistPath(label);
  const service = bridgeServiceName(label);
  const workspace = bridgeWorkspace(label);
  if (!existsSync(plist)) {
    console.error(`[brainclaw] no plist found at ${plist}`);
    process.exit(1);
  }
  const { spawnSync } = await import("child_process");
  const uid = spawnSync("id", ["-u"], { encoding: "utf8" }).stdout.trim();
  spawnSync("launchctl", ["bootout", `gui/${uid}/${service}`], { encoding: "utf8" });
  console.log(`[brainclaw] bootout ${service} (non-fatal if not loaded)`);
  const { unlinkSync } = await import("fs");
  try { unlinkSync(plist); console.log(`[brainclaw] removed plist: ${plist}`); } catch {}
  console.log("");
  console.log(`[brainclaw] Workspace retained at: ${workspace}`);
  console.log("[brainclaw] If you want to fully remove the creator's bridge:");
  console.log(`[brainclaw]   rm -rf ${workspace}`);
  console.log(`[brainclaw]   # then optionally purge keychain:`);
  console.log(`[brainclaw]   AP_KEYCHAIN_SERVICE=${bridgeKeychainService(label)} brainclaw keychain purge --all`);
}

// ── brainclaw bridge enroll ─────────────────────────────────────────────────
//
// Cycle 22.28 (Mike, 2026-04-26): one-shot agent onboarding into an
// existing bridge. Prior to this, adding a new agent's apt_ to a running
// bridge required (a) `brainclaw keychain stash` AND (b) hand-editing
// ap-client.json AND (c) launchctl kickstart by hand. Three steps =
// three places to fumble. This subcommand atomically:
//
//   1. Validates the apt_ via GET /agent/me (catches typos/revoked tokens)
//   2. Confirms the apt_ matches the claimed passportId (no impersonation)
//   3. Stashes apt_ (and aptr_ if provided) in the macOS Keychain bucket
//      keyed by the bridge's KEYCHAIN_SERVICE (default com.myclawpassport.bridge)
//   4. Reads the existing config, appends a tokenPair entry — or updates
//      in place if the passportId is already there (idempotent)
//   5. Writes the config atomically with a timestamped backup
//   6. Reloads the launchd service so the bridge picks up the new agent
//      within seconds, no SIGHUP / no manual restart
//
// Designed so a creator can go from "I just created an AI passport on
// the web UI" → "the agent replies in rooms" with ONE shell command.
async function cmdBridgeEnroll(rest) {
  ensureMacOS();
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(`brainclaw bridge enroll <passportId> { --apt apt_xxx | --aptr aptr_xxx } [options]

Onboard a new agent into the running PrMaat bridge in one shot.

Required (one of):
  <passportId>           did:myclawpassport:... (the agent's DID)
  --apt apt_xxx          The apt_ token (shown ONCE on the web UI after
                         passport creation; save it from a password manager).
  --aptr aptr_xxx        Rotate-scoped token. New aptr_-only enrollment path
                         (room vote 2026-04-26 Q2🅐): if you pass --aptr
                         WITHOUT --apt, the CLI mints a fresh apt_ for you
                         on the spot via /api/passports/:id/regenerate-token.
                         Removes the operator footgun of handling raw apt_
                         strings, and makes recovery from a stale-token
                         incident the same flow as steady-state enrollment.

If you pass both, --apt is used directly and --aptr is stashed alongside it
for T1.5 auto-rotate. If you pass only --aptr, both tokens end up in
Keychain (apt_ minted, aptr_ stashed verbatim).

Optional:
  --label "Friendly Name" Defaults to the passport's agent_name on the server.
  --brain <kind>         Brain override (e.g. "claude-code"). Default:
                         OpenClaw lookup by passport.local_agent_name.
  --brainBin <path>      Brain executable (used with --brain).
  --workingDir <path>    Working directory for the brain.
  --config <path>        Override config path.
                         Default: $AP_CONFIG or ${DEFAULT_CONFIG}
  --no-reload            Don't restart launchd after writing config.
                         Useful for batch enrollment; reload manually with
                         launchctl kickstart -k gui/$(id -u)/com.myclawpassport.bridge
  --join-room <roomId>   After successful enrollment + bridge reload, call
                         POST /agent/rooms/:id/join with the apt_ to add
                         the agent as a member of the specified room.
                         Repeat the flag for multiple rooms, or pass a
                         comma-separated list. Without this, the agent
                         is on the bridge but not in any room — @-mentions
                         have nowhere to land. Failures are logged and do
                         NOT abort enrollment.

Example (basic):
  brainclaw bridge enroll did:myclawpassport:xeqaC7-eHrsZEfxQa0-iB \\
    --apt apt_k_KUxikxUJ7U-vt97g_vPOnkQlBXWYnd1ttqcbSgwK9sKGdt \\
    --label Imhotep

Example (with room joins):
  brainclaw bridge enroll did:myclawpassport:xeqaC7-eHrsZEfxQa0-iB \\
    --apt apt_k_KUxikxUJ7U-vt97g_vPOnkQlBXWYnd1ttqcbSgwK9sKGdt \\
    --label Imhotep \\
    --join-room LWJn8xCiUrLGXgYmRYDZc \\
    --join-room 8VSvViCnN-gbqznpvpfYx
`);
    return;
  }

  // Parse args. Positional is passportId; everything else is flags.
  let passportId = null, apt = null, aptr = null, label = null;
  let brain = null, brainBin = null, workingDir = null;
  let configPath = process.env.AP_CONFIG || DEFAULT_CONFIG;
  let skipReload = false;
  // Cycle 22.32: --join-room flag (or repeated). Today's pain point: an
  // enrolled agent stays silent in any room it isn't a MEMBER of, even
  // though the bridge has its apt_ ready to dispatch. Mike hit this with
  // both Imhotep iterations. The flag accepts a room ID OR a comma-
  // separated list, and after enrollment+kickstart, calls
  // POST /agent/rooms/:id/join with the apt_ for each.
  const joinRooms = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("did:myclawpassport:") && !passportId) passportId = a;
    else if (a === "--apt"        && rest[i + 1]) apt        = rest[++i];
    else if (a === "--aptr"       && rest[i + 1]) aptr       = rest[++i];
    else if (a === "--label"      && rest[i + 1]) label      = rest[++i];
    else if (a === "--brain"      && rest[i + 1]) brain      = rest[++i];
    else if (a === "--brainBin"   && rest[i + 1]) brainBin   = rest[++i];
    else if (a === "--workingDir" && rest[i + 1]) workingDir = rest[++i];
    else if (a === "--config"     && rest[i + 1]) configPath = rest[++i];
    else if (a === "--join-room"  && rest[i + 1]) {
      // Accept comma-separated OR repeat --join-room.
      const ids = rest[++i].split(",").map((s) => s.trim()).filter(Boolean);
      joinRooms.push(...ids);
    }
    else if (a === "--no-reload") skipReload = true;
  }

  if (!passportId || (!apt && !aptr)) {
    console.error(`[brainclaw] usage: brainclaw bridge enroll <passportId> { --apt apt_xxx | --aptr aptr_xxx } [options]`);
    console.error(`[brainclaw]        run  brainclaw bridge enroll --help  for full options`);
    process.exit(2);
  }
  if (!passportId.startsWith("did:myclawpassport:")) {
    console.error(`[brainclaw] passportId must start with did:myclawpassport: (got "${passportId}")`);
    process.exit(2);
  }
  if (apt && !apt.startsWith("apt_")) {
    console.error(`[brainclaw] apt token must start with apt_`);
    process.exit(2);
  }
  if (aptr && !aptr.startsWith("aptr_")) {
    console.error(`[brainclaw] aptr token must start with aptr_`);
    process.exit(2);
  }

  // Self-healing Q2🅐 (room vote 2026-04-26): aptr_-only enroll path.
  // When operator passes --aptr but no --apt, we mint a fresh apt_ on
  // the spot via /api/passports/:id/regenerate-token. This removes the
  // operator footgun of handling raw apt_ strings (which appear ONCE
  // per Police's policy and are easy to lose) and makes recovery from
  // a stale-token incident the same flow as steady-state enrollment.
  if (!apt && aptr) {
    console.log(`[brainclaw] aptr_-only enrollment: minting fresh apt_ via /api/passports/${passportId}/regenerate-token ...`);
    try {
      const rotateUrl = `${DEFAULT_VPS}/api/passports/${passportId}/regenerate-token`;
      const res = await fetch(rotateUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${aptr}`,
          "Content-Type": "application/json",
          "User-Agent": "brainclaw bridge enroll (aptr_-only)",
        },
        body: JSON.stringify({ bindToOrigin: false }),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 240);
        console.error(`[brainclaw] regenerate-token returned ${res.status}: ${body}`);
        console.error(`[brainclaw] aptr_ rejected. Token may be revoked, expired, or bound to a different passport.`);
        process.exit(1);
      }
      const data = await res.json();
      apt = data.apiToken || data.token || data.apt;
      if (!apt || !apt.startsWith("apt_")) {
        console.error(`[brainclaw] regenerate-token response missing apt_; aborting`);
        console.error(`[brainclaw] response: ${JSON.stringify(data).slice(0, 300)}`);
        process.exit(1);
      }
      console.log(`[brainclaw] ✓ minted apt_ ${apt.slice(0, 8)}...${apt.slice(-4)} (expires ${data.apiTokenExpiresAt || "?"})`);
    } catch (err) {
      console.error(`[brainclaw] aptr_-driven mint failed: ${err.message}`);
      console.error(`[brainclaw] check network / AP_HTTP env var. Aborting before keychain or config writes.`);
      process.exit(1);
    }
  }

  // 1. Validate apt_ + bind to passportId via /agent/me
  const meUrl = `${DEFAULT_VPS}/agent/me`;
  console.log(`[brainclaw] validating apt_ via ${meUrl} ...`);
  let agentInfo = null;
  try {
    const res = await fetch(meUrl, {
      headers: { Authorization: `Bearer ${apt}` },
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 240);
      console.error(`[brainclaw] /agent/me returned ${res.status}: ${body}`);
      console.error(`[brainclaw] apt_ rejected. Token may be revoked, expired, or for a different VPS.`);
      console.error(`[brainclaw] If the token is fresh, double-check AP_HTTP env var (current: ${DEFAULT_VPS}).`);
      process.exit(1);
    }
    agentInfo = await res.json();
    if (agentInfo.passportId !== passportId) {
      console.error(`[brainclaw] passportId mismatch:`);
      console.error(`[brainclaw]   you provided: ${passportId}`);
      console.error(`[brainclaw]   apt_ binds to: ${agentInfo.passportId}`);
      console.error(`[brainclaw] aborting — refusing to stash a token under the wrong DID.`);
      process.exit(1);
    }
    console.log(`[brainclaw] ✓ apt_ valid for ${agentInfo.agentName} (${agentInfo.agentType}, trust ${agentInfo.trustScore})`);
  } catch (err) {
    console.error(`[brainclaw] failed to reach ${meUrl}: ${err.message}`);
    console.error(`[brainclaw] check network / AP_HTTP env var. Aborting before keychain or config writes.`);
    process.exit(1);
  }
  if (!label) label = agentInfo.agentName || "(unnamed)";

  // 2. Stash apt_ (and aptr_) in macOS Keychain
  console.log(`[brainclaw] stashing apt_ in Keychain (service=${KEYCHAIN_SERVICE}) ...`);
  const aptOk = await keychainSet(aptAccount(passportId), apt);
  if (!aptOk) {
    console.error(`[brainclaw] keychain stash for apt_ FAILED. aborting before config edit.`);
    process.exit(1);
  }
  console.log(`[brainclaw] ✓ apt_ stashed at account=${aptAccount(passportId)}`);
  if (aptr) {
    const aptrOk = await keychainSet(aptrAccount(passportId), aptr);
    if (aptrOk) console.log(`[brainclaw] ✓ aptr_ stashed (T1.5 auto-rotate enabled)`);
    else console.warn(`[brainclaw] ! aptr_ stash failed; continuing with apt_-only (T1.5 disabled).`);
  } else {
    console.warn(`[brainclaw] ! no --aptr provided. T1.5 auto-rotate disabled.`);
    console.warn(`[brainclaw]   bridge will drop this agent ~7d from now when apt_ expires.`);
    console.warn(`[brainclaw]   to enable: rotate via web UI to mint an aptr_, then re-run with --aptr.`);
  }

  // 3. Read + update config atomically
  if (!existsSync(configPath)) {
    console.error(`[brainclaw] config not found at ${configPath}`);
    console.error(`[brainclaw] run  brainclaw init  first, or pass --config <path>.`);
    process.exit(1);
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    console.error(`[brainclaw] config parse failed (${configPath}): ${err.message}`);
    process.exit(1);
  }
  if (!Array.isArray(cfg.tokenPairs)) cfg.tokenPairs = [];

  const newPair = {
    apt: null,                  // Track-2: apt_ lives in Keychain only
    aptr: null,                 // ditto
    passportId,
    label,
    rotatedAt: new Date().toISOString(),
    migration: "track-2:keychain",
    note: `enrolled via 'brainclaw bridge enroll' on ${new Date().toISOString().slice(0, 10)}`,
  };
  if (brain)      newPair.brain      = brain;
  if (brainBin)   newPair.brainBin   = brainBin;
  if (workingDir) newPair.workingDir = workingDir;

  // Idempotent — if passport already enrolled, merge non-null overrides.
  const existingIdx = cfg.tokenPairs.findIndex((p) => p && p.passportId === passportId);
  if (existingIdx >= 0) {
    console.log(`[brainclaw] passportId already in tokenPairs (index ${existingIdx}) — updating in place.`);
    cfg.tokenPairs[existingIdx] = { ...cfg.tokenPairs[existingIdx], ...newPair };
  } else {
    cfg.tokenPairs.push(newPair);
    console.log(`[brainclaw] ✓ tokenPair appended (now ${cfg.tokenPairs.length} agent(s) on this bridge)`);
  }

  // Atomic write: backup → temp → rename. 0600 perms throughout.
  const backupPath = `${configPath}.bak-enroll-${Date.now()}`;
  try {
    writeFileSync(backupPath, readFileSync(configPath), { mode: 0o600 });
  } catch (err) {
    console.error(`[brainclaw] backup write failed (${backupPath}): ${err.message}`);
    process.exit(1);
  }
  const tmpPath = `${configPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmpPath, configPath);
  try { chmodSync(configPath, 0o600); } catch {}
  console.log(`[brainclaw] ✓ config updated; backup at ${backupPath}`);

  // 4. Reload launchd so the bridge picks up the new agent
  if (skipReload) {
    console.log(``);
    console.log(`[brainclaw] --no-reload set; bridge still running with old config.`);
    console.log(`[brainclaw]   reload manually: launchctl kickstart -k gui/$(id -u)/com.myclawpassport.bridge`);
    return;
  }

  console.log(`[brainclaw] reloading bridge ...`);
  const { spawnSync } = await import("child_process");
  const uid = spawnSync("id", ["-u"], { encoding: "utf8" }).stdout.trim();
  const SVC = "com.myclawpassport.bridge";
  // -k forces kill + restart even if already running. The launchd plist
  // has KeepAlive=true so it'll come back automatically. ThrottleInterval
  // is 10s in the plist, so we may see a brief window where the bridge
  // hasn't reconnected yet — that's expected.
  const r = spawnSync("launchctl", ["kickstart", "-k", `gui/${uid}/${SVC}`], { encoding: "utf8" });
  if (r.status === 0) {
    console.log(`[brainclaw] ✓ bridge reloaded (kickstart -k gui/${uid}/${SVC})`);
  } else {
    console.warn(`[brainclaw] ! launchctl kickstart returned ${r.status}: ${(r.stderr || r.stdout || "").trim()}`);
    console.warn(`[brainclaw]   bridge may not be loaded. Check:  brainclaw status`);
  }

  // 5. Optional: join the agent into specified rooms (cycle 22.32).
  // We use the apt_ (not aptr_) and call POST /agent/rooms/:id/join. The
  // server checks room policy (private rooms admit only the creator's
  // own fleet; invite-only require an existing invitation; etc.) and
  // returns 200 on success or 403 with a reason on rejection. We report
  // each result and never abort enrollment if a join fails — the agent
  // is still successfully on the bridge, just not in that specific room.
  if (joinRooms.length > 0) {
    console.log(``);
    console.log(`[brainclaw] joining ${joinRooms.length} room(s)…`);
    for (const roomId of joinRooms) {
      try {
        const res = await fetch(`${DEFAULT_VPS}/agent/rooms/${encodeURIComponent(roomId)}/join`, {
          method: "POST",
          headers: {
            "Content-Type":  "application/json",
            "Authorization": `Bearer ${apt}`,
          },
          body: JSON.stringify({}),
        });
        if (res.ok) {
          const body = await res.json().catch(() => ({}));
          const note = body.message ? ` (${body.message})` : "";
          console.log(`[brainclaw]   ✓ joined ${roomId.slice(0, 24)}${note}`);
        } else {
          const body = (await res.text()).slice(0, 200);
          console.warn(`[brainclaw]   ! ${roomId.slice(0, 24)} → HTTP ${res.status}: ${body.replace(/\n/g, " ").slice(0, 120)}`);
        }
      } catch (err) {
        console.warn(`[brainclaw]   ! ${roomId.slice(0, 24)} → fetch threw: ${err.message}`);
      }
    }
  }

  console.log(``);
  console.log(`[brainclaw] ✅ Enrollment complete.`);
  console.log(`[brainclaw]    ${agentInfo.agentName} (${passportId.slice(-12)}) is now on the bridge.`);
  if (joinRooms.length === 0) {
    console.log(`[brainclaw]    Reminder: agent only replies in rooms it's a MEMBER of.`);
    console.log(`[brainclaw]    Use --join-room <roomId>[,<roomId>...] to join in one shot,`);
    console.log(`[brainclaw]    or click "Join as this passport" in the room UI.`);
  } else {
    console.log(`[brainclaw]    Test by @-mentioning the agent in any of the joined rooms.`);
  }
  console.log(`[brainclaw]    Watch:  tail -f ~/ap-client/ap-client.log | grep ${agentInfo.agentName}`);
}

// ── brainclaw bridge health ─────────────────────────────────────────────────
//
// Cycle 22.30 (post-incident, 2026-04-26): I rotated Claude's apt_ via
// the aptr_ from outside the bridge to post a room lead. The bridge's
// keychain still had the OLD apt_, which the server had revoked. On
// next bridge boot, Claude's apt_ failed /agent/me, the bootstrap
// crashed before Ma'at + Imhotep were hydrated, and KeepAlive
// infinite-looped. Mike's bridge was down until manual re-enroll.
//
// `brainclaw bridge health` scans every tokenPair in the config,
// pulls each apt_ from Keychain, and validates against /agent/me.
// Reports per-agent: valid / stale / no-keychain / passport-not-found.
// Stale entries get a copy-paste remediation hint: rotate via web UI +
// re-run `brainclaw bridge enroll` with the fresh apt_.
//
// Designed to run BEFORE attempting a kickstart, OR as a post-mortem
// diagnostic when the bridge is in a crashloop. The bridge's launchd
// log shows the same crash; this command shows it BEFORE the crash
// and tells you exactly which agent is broken.
async function cmdBridgeHealth(rest) {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(`brainclaw bridge health [--config path] [--json]

Scan every tokenPair in the bridge config and validate each apt_
against the server. Reports stale tokens that would crash the bridge
on next boot.

Options:
  --config <path>   Override config path (default: $AP_CONFIG or ${DEFAULT_CONFIG})
  --json            Emit machine-readable JSON instead of human report.

Exit codes:
  0  all token pairs valid
  1  one or more stale, can be fixed by re-enroll
  2  config error / can't read tokens
`);
    return;
  }

  let configPath = process.env.AP_CONFIG || DEFAULT_CONFIG;
  let asJson = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--config" && rest[i + 1]) configPath = rest[++i];
    else if (rest[i] === "--json") asJson = true;
  }

  if (!existsSync(configPath)) {
    console.error(`[brainclaw] config not found at ${configPath}`);
    process.exit(2);
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    console.error(`[brainclaw] config parse failed: ${err.message}`);
    process.exit(2);
  }
  const pairs = Array.isArray(cfg.tokenPairs) ? cfg.tokenPairs : [];
  if (pairs.length === 0) {
    if (asJson) console.log(JSON.stringify({ ok: true, agents: [] }));
    else console.log(`[brainclaw] config has no tokenPairs — nothing to check.`);
    return;
  }

  const results = [];
  for (const pair of pairs) {
    if (!pair?.passportId) continue;
    const result = {
      passportId: pair.passportId,
      label: pair.label || "(unnamed)",
      state: "unknown",
      detail: "",
      remedy: "",
    };

    // 1. Try keychain first (Track-2 path).
    let apt = null;
    if (process.platform === "darwin") {
      apt = await keychainGet(aptAccount(pair.passportId));
    }
    // 2. Fallback to file-stored apt_ (legacy / pre-migration).
    if (!apt && typeof pair.apt === "string" && pair.apt.startsWith("apt_")) {
      apt = pair.apt;
    }
    if (!apt) {
      result.state = "no-keychain";
      result.detail = "no apt_ found in Keychain or config file";
      result.remedy = `rotate via web UI, then: brainclaw bridge enroll ${pair.passportId} --apt apt_<NEW> [--label "${result.label}"]`;
      results.push(result);
      continue;
    }

    // 3. Validate via /agent/me.
    try {
      const res = await fetch(`${DEFAULT_VPS}/agent/me`, {
        headers: { Authorization: `Bearer ${apt}` },
      });
      if (res.ok) {
        const info = await res.json();
        if (info.passportId !== pair.passportId) {
          result.state = "wrong-binding";
          result.detail = `apt_ binds to ${info.passportId} but config says ${pair.passportId}`;
          result.remedy = `purge keychain + re-enroll: brainclaw keychain purge ${pair.passportId} && brainclaw bridge enroll ${pair.passportId} --apt apt_<NEW>`;
        } else {
          result.state = "valid";
          result.detail = `${info.agentName} (${info.agentType}, trust ${info.trustScore})`;
        }
      } else {
        const body = (await res.text()).slice(0, 240);
        const isStale = res.status === 401 || /Token expired|Invalid/.test(body);
        result.state = isStale ? "stale" : "error";
        result.detail = `HTTP ${res.status}: ${body.replace(/\n/g, " ").slice(0, 120)}`;
        result.remedy = isStale
          ? `rotate via web UI (or aptr_), then: brainclaw bridge enroll ${pair.passportId} --apt apt_<NEW> [--label "${result.label}"]`
          : `inspect server-side; this is not a normal stale-token failure`;
      }
    } catch (err) {
      result.state = "network-error";
      result.detail = err.message;
      result.remedy = "check network / AP_HTTP env var";
    }
    results.push(result);
  }

  // Cycle 22.30: detect SSH context. macOS Keychain blocks `security
  // find-generic-password` from non-UI processes by default — so health
  // run via SSH will report ALL agents as "no-keychain" even if they're
  // perfectly valid in the keychain. Surface this caveat instead of
  // silently misleading the operator.
  const isSsh = Boolean(process.env.SSH_CLIENT || process.env.SSH_CONNECTION);
  const allNoKeychain = results.length > 0 && results.every((r) => r.state === "no-keychain");

  if (asJson) {
    const summary = {
      ok: results.every((r) => r.state === "valid"),
      configPath,
      sshContextWarning: isSsh && allNoKeychain ? "macOS Keychain blocks find-generic-password from SSH sessions; run from a local Terminal" : null,
      agents: results,
    };
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[brainclaw] bridge health — ${results.length} agent(s) in ${configPath}\n`);
    if (isSsh && allNoKeychain) {
      console.log(`  ⚠️  SSH session detected. macOS Keychain refuses to expose entries to`);
      console.log(`      non-UI processes, so every agent below will look like "no-keychain"`);
      console.log(`      even when valid. Re-run from a local Terminal for accurate results.\n`);
    }
    let anyStale = false;
    for (const r of results) {
      const icon =
        r.state === "valid"          ? "✓"
        : r.state === "stale"        ? "✗"
        : r.state === "wrong-binding"? "✗"
        : r.state === "no-keychain"  ? "?"
        :                              "!";
      const stateColor =
        r.state === "valid"          ? "\x1b[32m"   // green
        : r.state === "stale"        ? "\x1b[31m"   // red
        : r.state === "wrong-binding"? "\x1b[31m"
        : r.state === "no-keychain"  ? "\x1b[33m"   // yellow
        :                              "\x1b[33m";
      const reset = "\x1b[0m";
      console.log(`  ${icon} ${stateColor}${r.state.padEnd(13)}${reset} ${r.label.padEnd(20)} ${r.passportId.slice(-12)}`);
      console.log(`     ${r.detail}`);
      if (r.remedy) {
        console.log(`     fix: ${r.remedy}`);
        if (r.state !== "valid") anyStale = true;
      }
      console.log("");
    }
    if (anyStale) {
      console.log(`[brainclaw] ✗ one or more agents need re-enrollment. See 'fix:' lines above.`);
    } else {
      console.log(`[brainclaw] ✓ all ${results.length} agents healthy. Bridge should boot clean.`);
    }
  }

  process.exit(results.every((r) => r.state === "valid") ? 0 : 1);
}

// ── Step 3 (room vote 2026-04-27 Q2=🅐 unanimous): bridge migrate ──
// Migrates a legacy single-bridge install (one shared ap-client.json,
// one shared keychain namespace, one launchd unit) into N per-creator
// bridges (one workspace + keychain + launchd unit per creator).
// Police's guardrail: reversible, with backup. UXAgent's guardrail:
// migration summary so operators see exactly what moved where.
async function cmdBridgeMigrate(rest) {
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(`brainclaw bridge migrate — migrate legacy single-bridge to per-creator isolation

Reads the shared config at ${DEFAULT_CONFIG}, looks up creator_id for each
tokenPair via /agent/me, and rebuckets each tokenPair into a per-creator
workspace at ~/.myclawpassport/creators/<slug>/. Generates per-creator
launchd plists. Migrates keychain entries from the shared service
'com.myclawpassport.bridge' to per-creator services.

Reversible: original config and keychain entries are PRESERVED with
.bak.migrate.<ts> suffixes. To roll back, set AP_SHARED_BRIDGE=1 and
restart the original launchd unit.

Options:
  --dry-run        Print the migration plan, don't change anything
  --no-keychain    Don't migrate keychain entries (leave them in shared service)
  --no-launchd     Don't generate per-creator launchd plists (config-only)
`);
    return;
  }
  ensureMacOS();
  ensureHomeDir();

  const dryRun = rest.includes("--dry-run");
  const skipKeychain = rest.includes("--no-keychain");
  const skipLaunchd = rest.includes("--no-launchd");

  if (!existsSync(DEFAULT_CONFIG)) {
    console.error(`[brainclaw] no shared config at ${DEFAULT_CONFIG} — nothing to migrate.`);
    return;
  }

  const cfg = JSON.parse(readFileSync(DEFAULT_CONFIG, "utf8"));
  const tokenPairs = cfg.tokenPairs || [];
  if (tokenPairs.length === 0) {
    console.log(`[brainclaw] shared config has 0 tokenPairs — nothing to migrate.`);
    return;
  }

  console.log(`[brainclaw] bridge migrate — ${dryRun ? "DRY RUN" : "REAL"} (${tokenPairs.length} tokenPair(s) to inspect)`);
  console.log("");

  // Resolve creator_id for each tokenPair via /agent/me. Need an apt_ to call
  // it; pull from keychain (shared service since this is the legacy install).
  const buckets = new Map(); // slug → { creatorId, label, pairs: [] }
  const summary = [];
  for (const tp of tokenPairs) {
    const passportId = tp.passportId;
    if (!passportId) {
      summary.push({ status: "skip", reason: "no passportId", tp });
      continue;
    }
    let apt = await keychainGet(aptAccount(passportId)); // shared service default
    if (!apt && tp.apt) apt = tp.apt; // legacy plaintext
    if (!apt) {
      summary.push({ status: "skip", reason: "no apt_ available (run brainclaw connect for this passport)", tp });
      continue;
    }
    let creatorId = null;
    try {
      const r = await fetch(`${DEFAULT_VPS}/agent/me`, {
        headers: { Authorization: `Bearer ${apt}` },
      });
      if (r.ok) {
        const j = await r.json();
        creatorId = j.creatorId || j.creator_id || null;
      } else {
        summary.push({ status: "skip", reason: `/agent/me HTTP ${r.status}`, tp });
        continue;
      }
    } catch (err) {
      summary.push({ status: "skip", reason: `network error: ${err.message}`, tp });
      continue;
    }
    if (!creatorId) {
      summary.push({ status: "skip", reason: "/agent/me didn't return creatorId", tp });
      continue;
    }
    const slug = creatorIdToSlug(creatorId);
    if (!buckets.has(slug)) buckets.set(slug, { creatorId, label: slug, pairs: [] });
    buckets.get(slug).pairs.push({ tp, apt, slug, creatorId });
    summary.push({ status: "plan", slug, creatorId, label: tp.label, passportId });
  }

  // Print migration plan
  console.log(`[brainclaw] migration plan:`);
  console.log(`  Source: ${DEFAULT_CONFIG} (${tokenPairs.length} pair(s))`);
  console.log(`  Targets: ${buckets.size} creator workspace(s)`);
  for (const [slug, bucket] of buckets) {
    console.log(`    → ${slug}  (creator: ${bucket.creatorId})`);
    for (const p of bucket.pairs) {
      console.log(`        - ${p.tp.label || p.tp.passportId.slice(-12)}  ${p.tp.passportId}`);
    }
  }
  const skipped = summary.filter((s) => s.status === "skip");
  if (skipped.length) {
    console.log(`  Skipped: ${skipped.length} pair(s):`);
    for (const s of skipped) {
      console.log(`    - ${s.tp?.label || s.tp?.passportId?.slice(-12) || "?"}: ${s.reason}`);
    }
  }
  console.log("");

  if (dryRun) {
    console.log(`[brainclaw] DRY RUN — no changes made. Drop --dry-run to execute.`);
    return;
  }

  // Backup shared config
  const backupTag = Date.now();
  const cfgBackup = `${DEFAULT_CONFIG}.bak.migrate.${backupTag}`;
  writeFileSync(cfgBackup, readFileSync(DEFAULT_CONFIG), { mode: 0o600 });
  console.log(`[brainclaw] ✓ backup: ${cfgBackup}`);

  // For each bucket: create workspace, write per-creator config, copy keychain entries
  const migrationReport = {
    ranAt: new Date().toISOString(),
    sourceConfig: DEFAULT_CONFIG,
    sourceBackup: cfgBackup,
    creators: [],
    skipped,
  };

  for (const [slug, bucket] of buckets) {
    ensureCreatorWorkspace(slug, bucket.label);
    const targetConfig = creatorConfig(slug);
    const targetSvc = creatorKeychainService(slug);
    const newCfg = {
      _creator: { id: bucket.creatorId, slug, migratedFrom: DEFAULT_CONFIG, migratedAt: new Date().toISOString() },
      tokenPairs: bucket.pairs.map((p) => ({
        apt: null,
        aptr: null,
        passportId: p.tp.passportId,
        label: p.tp.label,
        creatorId: bucket.creatorId,
        pairedAt: p.tp.pairedAt || new Date().toISOString(),
        migration: "track-2:keychain (per-creator, post-migrate)",
        note: "migrated from shared bridge by brainclaw bridge migrate",
      })),
    };
    writeFileSync(targetConfig, JSON.stringify(newCfg, null, 2), { mode: 0o600 });
    console.log(`[brainclaw] ✓ wrote ${targetConfig} (${newCfg.tokenPairs.length} pair(s))`);

    // Migrate keychain entries from shared → per-creator service
    if (!skipKeychain) {
      for (const p of bucket.pairs) {
        const aptVal = await keychainGet(aptAccount(p.tp.passportId)); // shared
        const aptrVal = await keychainGet(aptrAccount(p.tp.passportId));
        if (aptVal) await keychainSet(aptAccount(p.tp.passportId), aptVal, targetSvc);
        if (aptrVal) await keychainSet(aptrAccount(p.tp.passportId), aptrVal, targetSvc);
        // Don't delete from shared — Police's "reversible" guardrail. Operator can sweep later.
      }
      console.log(`[brainclaw]   → keychain copied into ${targetSvc} (shared entries kept for rollback)`);
    }

    // Generate per-creator launchd plist
    if (!skipLaunchd) {
      const plistPath = creatorPlistPath(slug);
      const plistLabel = creatorPlistLabel(slug);
      if (!existsSync(plistPath)) {
        const nodeBin = process.execPath;
        const apClient = BRIDGE_ENTRY;
        const workspace = creatorWorkspace(slug);
        const logPath = join(workspace, `${slug}.log`);
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTD/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${plistLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${apClient}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AP_HTTP</key><string>${DEFAULT_VPS}</string>
    <key>AP_CONFIG</key><string>${creatorConfig(slug)}</string>
    <key>AP_KEYCHAIN_SERVICE</key><string>${targetSvc}</string>
    <key>AP_CREATOR_SLUG</key><string>${slug}</string>
  </dict>
  <key>WorkingDirectory</key><string>${workspace}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
</dict>
</plist>
`;
        writeFileSync(plistPath, plist, { mode: 0o644 });
        console.log(`[brainclaw]   → launchd plist: ${plistPath}`);
      }
    }

    migrationReport.creators.push({
      slug,
      creatorId: bucket.creatorId,
      workspace: creatorWorkspace(slug),
      config: targetConfig,
      keychainService: targetSvc,
      plistLabel: creatorPlistLabel(slug),
      pairs: bucket.pairs.map((p) => ({ passportId: p.tp.passportId, label: p.tp.label })),
    });
  }

  // Write the migration report (UXAgent's guardrail)
  const reportPath = join(HOME_DIR, `migration-report.${backupTag}.json`);
  writeFileSync(reportPath, JSON.stringify(migrationReport, null, 2), { mode: 0o600 });
  console.log("");
  console.log(`[brainclaw] ✓ migration complete.`);
  console.log(`[brainclaw]   summary: ${reportPath}`);
  console.log(`[brainclaw]   to roll back: set AP_SHARED_BRIDGE=1 + restart the legacy bridge.`);
  console.log(`[brainclaw]   to load all per-creator daemons:`);
  for (const c of migrationReport.creators) {
    console.log(`     launchctl load ~/Library/LaunchAgents/${c.plistLabel}.plist`);
  }
}

async function cmdBridge(rest) {
  const sub = rest[0];
  const subrest = rest.slice(1);
  switch (sub) {
    case "init":       return cmdBridgeInit(subrest);
    case "list":       return cmdBridgeList(subrest);
    case "enroll":     return cmdBridgeEnroll(subrest);
    case "health":     return cmdBridgeHealth(subrest);
    case "migrate":    return cmdBridgeMigrate(subrest);
    case "uninstall":  return cmdBridgeUninstall(subrest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log("brainclaw bridge <cmd>\n");
      console.log("  init --creator <label>         Create a new per-creator bridge");
      console.log("  list                           List installed bridges + run state");
      console.log("  enroll <did> --apt apt_xxx     Onboard a new agent into the running bridge");
      console.log("                                 (validates token, stashes Keychain, updates");
      console.log("                                  config, reloads launchd — all in one shot)");
      console.log("  health                         Scan every tokenPair, validate each apt_,");
      console.log("                                 print remedies for any stale tokens");
      console.log("  migrate                        Migrate legacy single-bridge → per-creator");
      console.log("                                 isolation. Reversible (writes backups).");
      console.log("  uninstall --creator <label>    Remove a per-creator bridge (plist + launchd)");
      return;
    default:
      console.error(`[brainclaw] unknown subcommand: bridge ${sub}`);
      process.exit(2);
  }
}

// ── brainclaw connect ──────────────────────────────────────────────────────
// OAuth-style device-initiated bridge enrollment (Phase 1, room vote
// 2026-04-27 Lead 1: force-locked Q1=🅐 Q2=🅑 Q3=🅐). Eliminates the
// typed pairing code that bit Mike multiple times today (one device-name
// typo per attempt, average). Flow:
//
//   1. Bridge calls POST /api/devices/connect-init { deviceName }
//      → server returns device_code + user_code + verification_uri_complete
//   2. Bridge runs `open <verification_uri_complete>` to fire the system
//      browser onto the consent page (which already has the user_code in
//      the URL — operator never types the code).
//   3. Bridge polls GET /api/devices/connect-status?device_code=... every
//      `interval` seconds (default 2s).
//   4. When status == authorized, the response contains plaintext
//      apt_+aptr_ ONCE (server flips to claimed and nulls them).
//   5. Bridge stashes both in macOS Keychain (aptAccount/aptrAccount) and
//      writes a tokenPair entry into ap-client.json with apt:null aptr:null
//      (Track-2 keychain-only mode).
async function cmdConnect(rest) {
  ensureMacOS();
  ensureHomeDir();
  const configPath = process.env.AP_CONFIG || DEFAULT_CONFIG;

  // Parse optional flags. Default device name is the system hostname so the
  // operator doesn't need to type one — the consent page shows it as a
  // breadcrumb of "what's being authorized."
  const args = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--help" || a === "-h") {
      console.log(`brainclaw connect — OAuth-style bridge enrollment

Opens a consent page in your default browser. You sign in (if not already),
pick a passport from the dropdown, click Authorize. The bridge picks up
fresh apt_+aptr_ tokens automatically — no code typing, no token pasting.

Usage:
  brainclaw connect [options]

Options:
  --label "Friendly Name"  Optional label for this enrollment (default: hostname)
  --no-open                Print the URL instead of opening the browser
  --timeout <seconds>      How long to wait for authorization (default: 600)
  --help                   Show this help

Example:
  brainclaw connect
  brainclaw connect --label "Mike's MacBook"
`);
      return;
    }
    if (a === "--label" && rest[i + 1]) { args.label = rest[++i]; continue; }
    if (a === "--no-open") { args.noOpen = true; continue; }
    if (a === "--timeout" && rest[i + 1]) { args.timeout = parseInt(rest[++i], 10) || 600; continue; }
  }
  const deviceName = (args.label || hostname() || "unknown-device").trim().slice(0, 100);
  const timeoutMs = (args.timeout || 600) * 1000;

  console.log(`[brainclaw] connect — requesting authorization`);
  console.log(`[brainclaw]   device: ${deviceName}`);
  console.log(`[brainclaw]   vps:    ${DEFAULT_VPS}\n`);

  // ── 1. connect-init ───────────────────────────────────────────────
  let initRes;
  try {
    const r = await fetch(`${DEFAULT_VPS}/api/devices/connect-init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceName }),
    });
    if (!r.ok) {
      const body = (await r.text()).slice(0, 240);
      console.error(`[brainclaw] connect-init returned ${r.status}: ${body}`);
      process.exit(1);
    }
    initRes = await r.json();
  } catch (err) {
    console.error(`[brainclaw] failed to reach ${DEFAULT_VPS}/api/devices/connect-init: ${err.message}`);
    process.exit(1);
  }

  const { deviceCode, userCode, verificationUriComplete, expiresIn, interval } = initRes;
  if (!deviceCode || !userCode || !verificationUriComplete) {
    console.error(`[brainclaw] connect-init response missing fields. Server may be running an older build.`);
    console.error(`[brainclaw] keys returned: ${Object.keys(initRes).join(", ")}`);
    process.exit(1);
  }

  console.log(`[brainclaw] ✓ session created (code: ${userCode}, expires in ${expiresIn}s)`);
  console.log(`[brainclaw] ✓ opening browser to: ${verificationUriComplete}\n`);

  // ── 2. Open browser ────────────────────────────────────────────────
  if (!args.noOpen) {
    try {
      const child = spawn("open", [verificationUriComplete], { stdio: "ignore", detached: true });
      child.unref();
    } catch (err) {
      console.warn(`[brainclaw] could not auto-open browser: ${err.message}`);
      console.log(`[brainclaw] please open this URL manually: ${verificationUriComplete}`);
    }
  }
  console.log(`[brainclaw] waiting for authorization in browser... (Ctrl-C to cancel)\n`);

  // ── 3. Poll connect-status ────────────────────────────────────────
  const pollMs = (interval || 2) * 1000;
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "pending";
  let receivedApt = null;
  let receivedAptr = null;
  let receivedPassportId = null;
  let receivedPassportName = null;
  let receivedCreatorId = null;
  let receivedCreatorSlug = null;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    let pollRes;
    try {
      const r = await fetch(`${DEFAULT_VPS}/api/devices/connect-status?device_code=${encodeURIComponent(deviceCode)}`);
      pollRes = await r.json();
    } catch (err) {
      // Transient network error — keep trying within deadline.
      continue;
    }
    const s = pollRes.status;
    if (s === "expired") {
      console.error(`[brainclaw] ✗ code expired before authorization. Re-run \`brainclaw connect\` for a fresh one.`);
      process.exit(1);
    }
    if (s === "denied") {
      console.error(`[brainclaw] ✗ authorization denied by user.`);
      process.exit(1);
    }
    if (s === "claimed") {
      console.error(`[brainclaw] ✗ another bridge already claimed these tokens. Re-run \`brainclaw connect\`.`);
      process.exit(1);
    }
    if (s === "authorized" && pollRes.apt && pollRes.aptr) {
      receivedApt = pollRes.apt;
      receivedAptr = pollRes.aptr;
      receivedPassportId = pollRes.passportId;
      receivedPassportName = pollRes.passportName;
      receivedCreatorId = pollRes.creatorId;
      receivedCreatorSlug = pollRes.creatorSlug;
      console.log(`[brainclaw] ✓ authorized as "${receivedPassportName}" (${receivedPassportId})`);
      if (receivedCreatorSlug) {
        console.log(`[brainclaw]   creator: ${receivedCreatorSlug}`);
      }
      break;
    }
    if (s !== lastStatus) {
      console.log(`[brainclaw]   status: ${s}`);
      lastStatus = s;
    }
  }

  if (!receivedApt) {
    console.error(`[brainclaw] ✗ timed out after ${args.timeout || 600}s. Re-run \`brainclaw connect\`.`);
    process.exit(1);
  }

  // ── 4. Decide on per-creator vs shared bridge ─────────────────────
  // Step 3 (room vote 2026-04-27 Q1=🅐 unanimous, Q3=🅒 default-on with
  // override): when the server returned a creator id (v0.3.0+ servers do),
  // route this enrollment into a per-creator workspace + keychain
  // namespace + launchd unit. AP_SHARED_BRIDGE=1 reverts to the legacy
  // shared bridge for advanced operators who explicitly opt out.
  const usePerCreator = !!receivedCreatorSlug && !SHARED_BRIDGE_OVERRIDE;
  const slug = receivedCreatorSlug || null;
  const targetConfigPath = usePerCreator ? creatorConfig(slug) : configPath;
  const targetKeychainSvc = usePerCreator ? creatorKeychainService(slug) : KEYCHAIN_SERVICE;

  if (usePerCreator) {
    ensureCreatorWorkspace(slug, receivedPassportName ? `${receivedPassportName} (${receivedCreatorId.slice(-12)})` : slug);
    console.log(`[brainclaw] using per-creator isolation (creator: ${slug})`);
    console.log(`[brainclaw]   workspace: ${creatorWorkspace(slug)}`);
    console.log(`[brainclaw]   keychain:  ${targetKeychainSvc}`);
  } else if (SHARED_BRIDGE_OVERRIDE) {
    console.log(`[brainclaw] AP_SHARED_BRIDGE=1 set — falling back to shared bridge config`);
  } else {
    console.log(`[brainclaw] server didn't return creatorSlug — falling back to shared bridge (server may be < v0.3.0)`);
  }

  // ── 5. Stash in Keychain (per-creator service if applicable) ──────
  console.log(`[brainclaw] stashing apt_ + aptr_ in macOS Keychain ...`);
  const aptOk = await keychainSet(aptAccount(receivedPassportId), receivedApt, targetKeychainSvc);
  if (!aptOk) {
    console.error(`[brainclaw] ✗ keychain stash for apt_ failed.`);
    console.error(`[brainclaw]   Tokens are still on the server but not stored locally. Re-run from a Terminal app (NOT SSH).`);
    process.exit(1);
  }
  const aptrOk = await keychainSet(aptrAccount(receivedPassportId), receivedAptr, targetKeychainSvc);
  if (!aptrOk) {
    console.warn(`[brainclaw] ! aptr_ stash failed; T1.5 auto-rotation disabled.`);
  } else {
    console.log(`[brainclaw] ✓ apt_ + aptr_ stashed (T1.5 auto-rotation enabled)`);
  }

  // ── 6. Update / write config (preserve other tokenPairs) ──────────
  let cfg = { tokenPairs: [] };
  if (existsSync(targetConfigPath)) {
    try {
      cfg = JSON.parse(readFileSync(targetConfigPath, "utf8"));
      if (!Array.isArray(cfg.tokenPairs)) cfg.tokenPairs = [];
    } catch {
      console.warn(`[brainclaw] ! existing config unparseable; starting fresh`);
      cfg = { tokenPairs: [] };
    }
  }
  // Replace any prior entry for this passportId, otherwise append.
  const existingIdx = cfg.tokenPairs.findIndex((tp) => tp.passportId === receivedPassportId);
  const newPair = {
    apt: null,
    aptr: null,
    passportId: receivedPassportId,
    label: receivedPassportName || deviceName,
    creatorId: receivedCreatorId || null,
    pairedAt: new Date().toISOString(),
    migration: "track-2:keychain",
    note: `enrolled via 'brainclaw connect' on ${new Date().toISOString().slice(0, 10)}`,
  };
  if (existingIdx >= 0) cfg.tokenPairs[existingIdx] = newPair;
  else cfg.tokenPairs.push(newPair);

  // Tag the config root with creatorId for sanity / forensic trail.
  if (usePerCreator) {
    cfg._creator = { id: receivedCreatorId, slug };
  }
  writeFileSync(targetConfigPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  console.log(`[brainclaw] ✓ config updated at ${targetConfigPath}`);

  // ── 7. Generate per-creator launchd plist + load (if per-creator) ─
  if (usePerCreator) {
    const plistPath = creatorPlistPath(slug);
    const plistLabel = creatorPlistLabel(slug);
    if (!existsSync(plistPath)) {
      const nodeBin = process.execPath; // /opt/homebrew/bin/node typically
      const apClient = BRIDGE_ENTRY;
      const workspace = creatorWorkspace(slug);
      const logPath = join(workspace, `${slug}.log`);
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTD/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${plistLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${apClient}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AP_HTTP</key><string>${DEFAULT_VPS}</string>
    <key>AP_CONFIG</key><string>${creatorConfig(slug)}</string>
    <key>AP_KEYCHAIN_SERVICE</key><string>${targetKeychainSvc}</string>
    <key>AP_CREATOR_SLUG</key><string>${slug}</string>
  </dict>
  <key>WorkingDirectory</key><string>${workspace}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
</dict>
</plist>
`;
      writeFileSync(plistPath, plist, { mode: 0o644 });
      console.log(`[brainclaw] ✓ launchd plist generated at ${plistPath}`);
    }
    // Load it (idempotent — kickstart -k stops & restarts if already loaded)
    try {
      const r = spawn("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${plistLabel}`], { stdio: "inherit" });
      r.on("close", () => {});
    } catch (err) {
      // First-time load may need `launchctl load` (kickstart fails on unloaded plist).
      try {
        spawn("launchctl", ["load", plistPath], { stdio: "inherit" });
      } catch (err2) {
        console.warn(`[brainclaw] ! launchd load failed: ${err2.message}`);
      }
    }
    console.log(`[brainclaw] ✓ daemon ${plistLabel} kicked`);
  }

  console.log(``);
  console.log(`[brainclaw] connect — complete.`);
  if (usePerCreator) {
    console.log(`[brainclaw] this creator's bridge runs as ${creatorPlistLabel(slug)}.`);
    console.log(`[brainclaw] view all your bridges: brainclaw bridge list`);
  } else {
    console.log(`[brainclaw] next: brainclaw start  (or  launchctl kickstart -k gui/$(id -u)/com.myclawpassport.bridge)`);
  }
}

async function main() {
  const [, , cmd, ...rest] = process.argv;

  // v0.3.8 (Mike directive 2026-05-06, post peer-Claude principled-refusal
  // audit): two cross-cutting flags consumed BEFORE the per-command
  // dispatcher sees rest[]. They flip module-level guards so every prompt
  // (in any subcommand) becomes a hard error when --non-interactive is on,
  // and every "self-attestation" code path (env-derived model, etc.) is
  // refused when --no-self-attest is on. This gives AI agents and CI
  // runners a clean enrollment path: the operator pre-fills every
  // attestable value in --config, and the bridge runs purely operationally.
  const flagFiltered = [];
  for (const arg of rest) {
    if (arg === "--non-interactive") { setNonInteractive(true); continue; }
    if (arg === "--no-self-attest")  { setNoSelfAttest(true);  continue; }
    flagFiltered.push(arg);
  }

  switch (cmd) {
    case "start":    return cmdStart(flagFiltered);
    case "init":     return cmdInit(flagFiltered);
    case "connect":  return cmdConnect(flagFiltered);
    case "status":   return cmdStatus(flagFiltered);
    case "doctor":   return cmdDoctor(flagFiltered);
    case "keychain": return cmdKeychain(flagFiltered);
    case "bridge":   return cmdBridge(flagFiltered);
    case "version":
    case "--version":
    case "-v":       return printVersion();
    case "help":
    case "--help":
    case "-h":
    case undefined:  return printHelp();
    default:
      console.error(`[brainclaw] unknown command: ${cmd}`);
      printHelp();
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(`[brainclaw] fatal: ${err.message}`);
  process.exit(1);
});
