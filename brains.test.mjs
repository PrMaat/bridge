/**
 * Unit tests for the brain adapters. No external binaries required —
 * uses /bin/echo + /bin/cat (POSIX) to stand in for real LLM CLIs.
 *
 * Run:   node clients/mac-openclaw/brains.test.mjs
 * Exit:  0 if every assertion passed, 1 otherwise.
 */
import { makeRunBrain, brainClaudeCode, brainCodex, brainExec, BRAIN_REGISTRY_DEFAULT, sanitizeBrainOutput } from "./brains.mjs";

let passed = 0, failed = 0;
const log = (ok, name, detail) => {
  const mark = ok ? "✓" : "✗";
  console.log(`${mark} ${name}${detail ? `  — ${detail}` : ""}`);
  if (ok) passed++; else failed++;
};

async function assertEq(name, got, want) {
  if (got === want) log(true, name);
  else log(false, name, `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

async function assertStarts(name, got, prefix) {
  if (typeof got === "string" && got.startsWith(prefix)) log(true, name);
  else log(false, name, `got=${JSON.stringify(got?.slice?.(0, 80))} want prefix=${JSON.stringify(prefix)}`);
}

async function assertNull(name, got) {
  if (got === null) log(true, name);
  else log(false, name, `got=${JSON.stringify(got)} want=null`);
}

// ── exec adapter tests ──────────────────────────────────────────────────────

console.log("── exec adapter ──");

// T1: arg mode with {{message}} substitution
{
  const agent = { name: "t1", brain: "exec", command: ["/bin/echo", "reply: {{message}}"], input: "arg" };
  const out = await brainExec(agent, "hello");
  await assertEq("T1 exec/arg substitutes {{message}}", out, "reply: hello");
}

// T2: stdin mode — message piped in, /bin/cat echoes it back
{
  const agent = { name: "t2", brain: "exec", command: ["/bin/cat"], input: "stdin" };
  const out = await brainExec(agent, "piped-msg");
  await assertEq("T2 exec/stdin pipes message to stdin", out, "piped-msg");
}

// T3: default input mode is stdin
{
  const agent = { name: "t3", brain: "exec", command: ["/bin/cat"] };
  const out = await brainExec(agent, "default-mode");
  await assertEq("T3 exec default input mode is stdin", out, "default-mode");
}

// T4: missing command array → null + error logged
{
  const agent = { name: "t4", brain: "exec" }; // no command
  const out = await brainExec(agent, "x");
  await assertNull("T4 exec without command[] returns null", out);
}

// T5: empty command array → null
{
  const agent = { name: "t5", brain: "exec", command: [] };
  const out = await brainExec(agent, "x");
  await assertNull("T5 exec with empty command returns null", out);
}

// T6: nonexistent binary → null (graceful failure, not throw)
{
  const agent = { name: "t6", brain: "exec", command: ["/does/not/exist"], input: "stdin" };
  const out = await brainExec(agent, "x");
  await assertNull("T6 exec with missing binary returns null", out);
}

// T7: command that exits nonzero with no stdout → null
{
  const agent = { name: "t7", brain: "exec", command: ["/bin/sh", "-c", "exit 1"], input: "stdin" };
  const out = await brainExec(agent, "x");
  await assertNull("T7 exec with nonzero exit + empty stdout returns null", out);
}

// T8: command that exits nonzero but still wrote stdout → stdout is returned
// (matches behavior: LLM CLIs sometimes emit a partial reply before failing)
{
  const agent = { name: "t8", brain: "exec", command: ["/bin/sh", "-c", "echo 'partial'; exit 3"], input: "stdin" };
  const out = await brainExec(agent, "x");
  await assertEq("T8 exec: stdout returned despite nonzero exit", out, "partial");
}

// ── claude-code / codex adapters (just verify they spawn correctly with fake bins) ──

console.log("\n── claude-code adapter ──");

// T9: falls through to execWithStdin using a fake bin
{
  const agent = { name: "t9", brain: "claude-code", brainBin: "/bin/cat", brainArgs: [] };
  const out = await brainClaudeCode(agent, "claude-msg");
  await assertEq("T9 claude-code pipes message via stdin", out, "claude-msg");
}

// T10: model flag appended if provided
{
  // Verify by using /bin/sh to echo the last arg; if --model X was appended,
  // /bin/sh -c "echo $2" X -- actually... let's use a script that echoes its args.
  const agent = {
    name: "t10",
    brain: "claude-code",
    brainBin: "/bin/sh",
    brainArgs: ["-c", "echo ARGS: $@; cat", "--"],
    model: "claude-sonnet-4-5",
  };
  const out = await brainClaudeCode(agent, "msg");
  // We expect args echo to include --model claude-sonnet-4-5
  await assertStarts("T10 claude-code appends --model flag", out, "ARGS: --");
  if (out && out.includes("--model claude-sonnet-4-5")) log(true, "T10b claude-code --model X present in args");
  else log(false, "T10b claude-code --model X present in args", `out=${out?.slice(0, 120)}`);
}

console.log("\n── codex adapter ──");

// T11: spawn + stdin pipe
{
  const agent = { name: "t11", brain: "codex", brainBin: "/bin/cat", brainArgs: [] };
  const out = await brainCodex(agent, "codex-msg");
  await assertEq("T11 codex pipes message via stdin", out, "codex-msg");
}

// ── dispatcher tests ────────────────────────────────────────────────────────

console.log("\n── dispatcher (makeRunBrain) ──");

// Build a dispatcher with a mock legacy openclaw runner we can assert on.
let legacyCalls = [];
async function fakeLegacyRunOpenClaw(agentName, message) {
  legacyCalls.push({ agentName, message });
  return `legacy-reply:${agentName}:${message}`;
}
const runBrain = makeRunBrain(fakeLegacyRunOpenClaw);

// T12: agent with brain: "openclaw" routes through legacy runner
{
  legacyCalls = [];
  const out = await runBrain({ name: "t12", brain: "openclaw", openclawAgent: "te-client" }, "msg");
  await assertEq("T12 dispatcher routes brain=openclaw to legacy", out, "legacy-reply:te-client:msg");
  await assertEq("T12b dispatcher called legacy once", legacyCalls.length, 1);
}

// T13: legacy config without "brain" but WITH openclawAgent → auto-migrates
{
  legacyCalls = [];
  const out = await runBrain({ name: "t13", openclawAgent: "te-client" }, "auto-migrate");
  await assertEq("T13 dispatcher auto-migrates legacy openclawAgent → brain=openclaw", out, "legacy-reply:te-client:auto-migrate");
}

// T14: agent with brain: "exec" uses exec adapter (not legacy)
{
  legacyCalls = [];
  const out = await runBrain({
    name: "t14",
    brain: "exec",
    command: ["/bin/echo", "exec-reply: {{message}}"],
    input: "arg",
  }, "hi");
  await assertEq("T14 dispatcher routes brain=exec to exec adapter", out, "exec-reply: hi");
  await assertEq("T14b legacy runner NOT called for brain=exec", legacyCalls.length, 0);
}

// T15: unknown brain → null + error logged
{
  const out = await runBrain({ name: "t15", brain: "does-not-exist" }, "x");
  await assertNull("T15 dispatcher rejects unknown brain", out);
}

// T16: agent with neither brain nor openclawAgent → null + error logged
{
  const out = await runBrain({ name: "t16" }, "x");
  await assertNull("T16 dispatcher rejects agent with no brain config", out);
}

// T17: BRAIN_REGISTRY_DEFAULT excludes openclaw (since legacy runner must be injected)
{
  const hasOpenclaw = "openclaw" in BRAIN_REGISTRY_DEFAULT;
  await assertEq("T17 BRAIN_REGISTRY_DEFAULT excludes openclaw (requires legacy runner)", hasOpenclaw, false);
  await assertEq("T17b BRAIN_REGISTRY_DEFAULT includes exec", "exec" in BRAIN_REGISTRY_DEFAULT, true);
  await assertEq("T17c BRAIN_REGISTRY_DEFAULT includes claude-code", "claude-code" in BRAIN_REGISTRY_DEFAULT, true);
  await assertEq("T17d BRAIN_REGISTRY_DEFAULT includes codex", "codex" in BRAIN_REGISTRY_DEFAULT, true);
}

// ── sanitizeBrainOutput tests ───────────────────────────────────────────────
// Regression: openclaw 2026-04-30 release started writing plugin-loader debug
// output to stdout instead of stderr; the bridge then posted that as a chat
// reply. The sanitizer strips the noise; these tests pin its behavior.

console.log("\n── sanitizeBrainOutput ──");

// T18: empty / null input → null (signals "no real reply")
{
  await assertNull("T18 sanitize empty string returns null", sanitizeBrainOutput(""));
  await assertNull("T18b sanitize null returns null", sanitizeBrainOutput(null));
  await assertNull("T18c sanitize undefined returns null", sanitizeBrainOutput(undefined));
}

// T19: real prose passes through untouched
{
  const out = sanitizeBrainOutput("Hello room, this is Ma'at.\nLooks good to me.");
  await assertEq("T19 sanitize keeps real prose", out, "Hello room, this is Ma'at.\nLooks good to me.");
}

// T20: [plugins] prefix lines are stripped
{
  const raw = "[plugins] runway staging bundled runtime deps (48 specs): @scope/pkg@1.2.3\nActual reply here.";
  const out = sanitizeBrainOutput(raw);
  await assertEq("T20 sanitize strips [plugins] prefix line", out, "Actual reply here.");
}

// T21: every recognized debug prefix is stripped
{
  const raw = [
    "[runtime] booting v2",
    "[deps] resolving",
    "[loader] init complete",
    "[init] hello",
    "[boot] hello",
    "[trace] enter fn",
    "[debug] x=1",
    "[info] starting",
    "[warn] deprecated",
    "the actual model reply",
  ].join("\n");
  const out = sanitizeBrainOutput(raw);
  await assertEq("T21 sanitize strips every recognized debug prefix", out, "the actual model reply");
}

// T22: npm-deps-style manifest dump (3+ pkg@ver entries) gets stripped
{
  const raw = "@scope/a@1.0.0, @scope/b@2.0.0, @scope/c@3.0.0, @scope/d@4.0.0\nReply text.";
  const out = sanitizeBrainOutput(raw);
  await assertEq("T22 sanitize strips npm-deps manifest run", out, "Reply text.");
}

// T23: blank lines preserved for paragraph structure
{
  const raw = "First paragraph.\n\nSecond paragraph.";
  const out = sanitizeBrainOutput(raw);
  await assertEq("T23 sanitize preserves blank lines", out, "First paragraph.\n\nSecond paragraph.");
}

// T24: only-noise input → null (nothing to post)
{
  const raw = "[plugins] foo\n[runtime] bar\n[deps] baz\n";
  const out = sanitizeBrainOutput(raw);
  await assertNull("T24 sanitize all-noise input returns null", out);
}

// T25: prose that *mentions* plugins (no leading bracket) is kept
{
  const raw = "Our plugins system uses runtime hooks. Try [plugins] config.";
  const out = sanitizeBrainOutput(raw);
  await assertEq("T25 sanitize keeps prose that mentions 'plugins' inline", out, "Our plugins system uses runtime hooks. Try [plugins] config.");
}

// T26: Markdown code-block fences with brackets in content are kept
{
  const raw = "Here is the config:\n```\n{ \"foo\": \"bar\" }\n```\nDone.";
  const out = sanitizeBrainOutput(raw);
  await assertEq("T26 sanitize keeps markdown code fences", out, raw);
}

// T27: end-to-end through brainExec — plugin noise mixed with prose
// Simulates real openclaw stdout: noise + actual reply
{
  const script = `printf '[plugins] runway staging bundled runtime deps (48 specs): @scope/pkg@1.0.0\\n[runtime] init\\nThis is the real model reply.\\n'`;
  const agent = { name: "t27", brain: "exec", command: ["/bin/sh", "-c", script], input: "stdin" };
  const out = await brainExec(agent, "x");
  await assertEq("T27 exec adapter strips plugin noise from stdout", out, "This is the real model reply.");
}

// T28: end-to-end — output that's ONLY noise → null (bridge won't post)
{
  const script = `printf '[plugins] foo\\n[runtime] bar\\n[deps] baz\\n'`;
  const agent = { name: "t28", brain: "exec", command: ["/bin/sh", "-c", script], input: "stdin" };
  const out = await brainExec(agent, "x");
  await assertNull("T28 exec adapter returns null when stdout is all noise", out);
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
