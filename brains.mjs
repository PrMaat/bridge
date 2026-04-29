/**
 * Brain adapters — pluggable LLM invocation layer for the PrMaat bridge.
 *
 * Each adapter has the signature:
 *   async function brain(agent, message) → Promise<string | null>
 * Returns the model's reply text, or null if the brain couldn't produce one.
 *
 * The adapter to use is selected by agent.brain in ap-client.json (default:
 * "openclaw" for back-compat with legacy configs that used openclawAgent).
 *
 * Built-in adapters:
 *   openclaw    — the local OpenClaw CLI (current production default)
 *   claude-code — Anthropic's claude-code CLI (headless print mode)
 *   codex       — OpenAI Codex CLI (exec mode)
 *   exec        — generic command runner; agent supplies a command array and
 *                 the bridge pipes the message via stdin or arg substitution
 *
 * Config shape (canonical, new):
 *   {
 *     "name": "Imhotep",
 *     "passportId": "did:myclawpassport:...",
 *     "token": "apt_...",
 *     "rooms": ["..."],
 *     "brain": "openclaw",                    // selects the adapter
 *     "openclawAgent": "te-client"            // adapter-specific field
 *   }
 *
 * Legacy shape (auto-migrated, no migration required on disk):
 *   {
 *     "name": "Imhotep",
 *     ...,
 *     "openclawAgent": "te-client"            // brain defaults to "openclaw"
 *   }
 */
import { execFile, spawn } from "child_process";

// ── Shared helpers ──────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = parseInt(process.env.BRAIN_TIMEOUT_MS || process.env.OPENCLAW_TIMEOUT_MS || "120000", 10);
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

function execArgv(bin, args, { cwd, timeout = DEFAULT_TIMEOUT_MS, env } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, timeout, maxBuffer: DEFAULT_MAX_BUFFER, env: env || process.env }, (err, stdout, stderr) => {
      if (err && !stdout) {
        console.error(`[brain/${bin}] exit error: ${err.message.slice(0, 200)}${stderr ? ` | stderr: ${String(stderr).slice(0, 200)}` : ""}`);
        return resolve(null);
      }
      const out = (stdout || "").trim();
      resolve(out || null);
    });
  });
}

function execWithStdin(bin, args, input, { cwd, timeout = DEFAULT_TIMEOUT_MS, env } = {}) {
  return new Promise((resolve) => {
    let finished = false;
    let to;
    const p = spawn(bin, args, { cwd, env: env || process.env });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(to);
      if (code !== 0 && !out.trim()) {
        console.error(`[brain/${bin}] exit ${code}: ${err.slice(0, 200)}`);
        return resolve(null);
      }
      resolve(out.trim() || null);
    });
    p.on("error", (e) => {
      if (finished) return;
      finished = true;
      clearTimeout(to);
      console.error(`[brain/${bin}] spawn error: ${e.message}`);
      resolve(null);
    });
    to = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { p.kill("SIGTERM"); } catch { /* already dead */ }
      console.error(`[brain/${bin}] timeout after ${timeout}ms`);
      resolve(null);
    }, timeout);
    try {
      p.stdin.write(input);
      p.stdin.end();
    } catch (e) {
      if (!finished) {
        finished = true;
        clearTimeout(to);
        console.error(`[brain/${bin}] stdin write error: ${e.message}`);
        resolve(null);
      }
    }
  });
}

// ── openclaw adapter ────────────────────────────────────────────────────────
// Wraps the existing OpenClaw CLI invocation. Caller must pass the legacy
// runner function (so the existing retry-on-transient-TLS logic stays in one
// place inside ap-client.mjs).
export function brainOpenclaw(runOpenClawLegacy) {
  return async function openclawAdapter(agent, message) {
    if (!agent.openclawAgent) {
      console.error(`[brain/openclaw] agent ${agent.name}: openclawAgent required`);
      return null;
    }
    return runOpenClawLegacy(agent.openclawAgent, message);
  };
}

// ── claude-code adapter ─────────────────────────────────────────────────────
// Runs Anthropic's claude-code CLI in headless print mode.
//   config: { brain: "claude-code", workingDir?: "...", bin?: "claude",
//             args?: ["--print"], model?: "claude-sonnet-4-5" }
// Message is passed via stdin to avoid command-line length + escape issues.
export async function brainClaudeCode(agent, message) {
  const bin = agent.brainBin || process.env.CLAUDE_CODE_BIN || "claude";
  const cwd = agent.workingDir || process.env.CLAUDE_CODE_CWD || undefined;
  const baseArgs = Array.isArray(agent.brainArgs) ? agent.brainArgs.slice() : ["--print"];
  if (agent.model && !baseArgs.includes("--model")) {
    baseArgs.push("--model", agent.model);
  }
  return execWithStdin(bin, baseArgs, message, { cwd });
}

// ── codex adapter ───────────────────────────────────────────────────────────
// Runs OpenAI Codex CLI in exec mode.
//   config: { brain: "codex", workingDir?: "...", bin?: "codex",
//             args?: ["exec"], model?: "gpt-5" }
export async function brainCodex(agent, message) {
  const bin = agent.brainBin || process.env.CODEX_BIN || "codex";
  const cwd = agent.workingDir || undefined;
  const baseArgs = Array.isArray(agent.brainArgs) ? agent.brainArgs.slice() : ["exec"];
  if (agent.model && !baseArgs.includes("--model")) {
    baseArgs.push("--model", agent.model);
  }
  return execWithStdin(bin, baseArgs, message, { cwd });
}

// ── exec adapter ────────────────────────────────────────────────────────────
// Generic command runner. Two modes:
//   1. stdin mode (default): agent.command = ["ollama", "run", "llama3"]
//      bridge pipes the message into the process's stdin
//   2. arg mode: agent.command = ["my-cli", "--prompt", "{{message}}"]
//      bridge substitutes {{message}} in each arg
//
//   { "brain": "exec", "command": ["ollama","run","llama3"], "input": "stdin" }
//   { "brain": "exec", "command": ["echo", "reply-to: {{message}}"], "input": "arg" }
export async function brainExec(agent, message) {
  if (!Array.isArray(agent.command) || agent.command.length === 0) {
    console.error(`[brain/exec] agent ${agent.name}: "command" array required`);
    return null;
  }
  const [bin, ...rest] = agent.command;
  const mode = agent.input === "arg" ? "arg" : "stdin";
  const cwd = agent.workingDir || undefined;
  if (mode === "arg") {
    const args = rest.map((a) => String(a).replace(/\{\{message\}\}/g, message));
    return execArgv(bin, args, { cwd });
  }
  return execWithStdin(bin, rest, message, { cwd });
}

// ── Registry + dispatcher ───────────────────────────────────────────────────

/**
 * Build the brain dispatcher. Caller passes the legacy runOpenClaw fn so the
 * openclaw adapter can reuse the transient-retry logic already in ap-client.mjs.
 * Returns (agent, message) → Promise<string | null>.
 */
export function makeRunBrain(runOpenClawLegacy) {
  const registry = {
    "openclaw": brainOpenclaw(runOpenClawLegacy),
    "claude-code": brainClaudeCode,
    "codex": brainCodex,
    "exec": brainExec,
  };
  return async function runBrain(agent, message) {
    // Resolve brain name: explicit > legacy openclawAgent fallback > error
    let brainName = agent.brain;
    if (!brainName && agent.openclawAgent) {
      brainName = "openclaw";
    }
    if (!brainName) {
      console.error(`[brain] agent ${agent.name}: no brain configured (add "brain": "openclaw"|"claude-code"|"codex"|"exec")`);
      return null;
    }
    const fn = registry[brainName];
    if (!fn) {
      console.error(`[brain] agent ${agent.name}: unknown brain "${brainName}". Known: ${Object.keys(registry).join(", ")}`);
      return null;
    }
    return fn(agent, message);
  };
}

// Default registry excluding openclaw (for callers that don't have the legacy
// runner wired — useful for tests or for future bridge rewrites).
export const BRAIN_REGISTRY_DEFAULT = {
  "claude-code": brainClaudeCode,
  "codex": brainCodex,
  "exec": brainExec,
};
