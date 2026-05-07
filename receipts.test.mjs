// Tests for receipts.mjs — keygen + JCS + sign + verify round-trip.
// Run: node receipts.test.mjs

import { generateDeviceKeypair, jcsCanonicalize, signReceipt, verifyReceipt, keyIdFromPublicKeyPem, computeReceiptHash } from "./receipts.mjs";
import assert from "assert";
import { createHash } from "crypto";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}`); console.error(`    ${err.message}`); failed++; }
}

console.log("\n[receipts.test.mjs] running...");

// ── JCS canonicalization vectors (subset of the official testdata) ─────────
console.log("\n  JCS canonicalization:");

test("null/true/false primitives", () => {
  assert.strictEqual(jcsCanonicalize(null), "null");
  assert.strictEqual(jcsCanonicalize(true), "true");
  assert.strictEqual(jcsCanonicalize(false), "false");
});

test("integer numbers", () => {
  assert.strictEqual(jcsCanonicalize(0), "0");
  assert.strictEqual(jcsCanonicalize(42), "42");
  assert.strictEqual(jcsCanonicalize(-1), "-1");
});

test("strings escape required characters", () => {
  assert.strictEqual(jcsCanonicalize("hello"), '"hello"');
  assert.strictEqual(jcsCanonicalize('he"llo'), '"he\\"llo"');
  assert.strictEqual(jcsCanonicalize("line\nbreak"), '"line\\nbreak"');
});

test("arrays preserve order", () => {
  assert.strictEqual(jcsCanonicalize([1, 2, 3]), "[1,2,3]");
  assert.strictEqual(jcsCanonicalize(["a", "b"]), '["a","b"]');
});

test("objects sort keys lexicographically", () => {
  // JCS § 3.2.3 — keys sorted by UTF-16 code units.
  assert.strictEqual(jcsCanonicalize({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.strictEqual(jcsCanonicalize({ z: 1, A: 2, a: 3 }), '{"A":2,"a":3,"z":1}');
});

test("nested object canonicalization", () => {
  const obj = { outer: { z: 1, a: 2 }, first: [3, 1, 2] };
  assert.strictEqual(jcsCanonicalize(obj), '{"first":[3,1,2],"outer":{"a":2,"z":1}}');
});

test("two equal objects canonicalize to identical bytes regardless of source order", () => {
  const a = { foo: 1, bar: 2 };
  const b = { bar: 2, foo: 1 };
  assert.strictEqual(jcsCanonicalize(a), jcsCanonicalize(b));
});

// ── Keypair generation ─────────────────────────────────────────────────────
console.log("\n  Keypair generation:");

let kp1, kp2;
test("generates a valid Ed25519 keypair", () => {
  kp1 = generateDeviceKeypair();
  assert.ok(kp1.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----"));
  assert.ok(kp1.privateKeyPem.startsWith("-----BEGIN PRIVATE KEY-----"));
  assert.strictEqual(kp1.keyId.length, 16);
  assert.strictEqual(kp1.fingerprint.length, 64);
});

test("two generations produce different keys", () => {
  kp2 = generateDeviceKeypair();
  assert.notStrictEqual(kp1.keyId, kp2.keyId);
});

test("keyId derivable from public key alone", () => {
  const derived = keyIdFromPublicKeyPem(kp1.publicKeyPem);
  assert.strictEqual(derived, kp1.keyId);
});

// ── Receipt sign/verify round trip ─────────────────────────────────────────
console.log("\n  Receipt sign/verify:");

const receipt = {
  v: "v0.2.1",
  room_id: "PY5d3w7WdW04HksrFKyPt",
  passport_did: "did:prmaat:HBZ0eiuoRGdFvJgfk9ORX",
  device_key_id: kp1.keyId,
  bridge_version: "0.4.0-rc.1",
  message_id: "msg_test_001",
  model_provider: { id: "anthropic/claude-opus-4-7", version: "20260101", declared_by: "operator" },
  prompt_hash: "a".repeat(64),
  tool_call_transcript_hash: "",
  output_hash: "b".repeat(64),
  capability_scope: { rooms: ["PY5d3w7WdW04HksrFKyPt"], rate: "5/min", actions: ["post"] },
  server_nonce: "test-nonce-001",
  timestamp: "2026-05-08T00:00:00.000Z",
  previous_receipt_hash: "0".repeat(64),
};

let signedR;
test("sign produces JWS + receiptHash", () => {
  signedR = signReceipt(receipt, kp1.privateKeyPem);
  assert.ok(signedR.jws);
  assert.ok(signedR.jws.split(".").length === 3);
  assert.strictEqual(signedR.receiptHash.length, 64);
  // canonical bytes should be deterministic
  const expectedHash = createHash("sha256").update(jcsCanonicalize(receipt)).digest("hex");
  assert.strictEqual(signedR.receiptHash, expectedHash);
});

test("verify with the right public key returns ok", () => {
  const v = verifyReceipt(receipt, signedR.jws, kp1.publicKeyPem);
  assert.strictEqual(v.ok, true, `expected ok, got: ${JSON.stringify(v)}`);
});

test("verify with a different public key fails", () => {
  const v = verifyReceipt(receipt, signedR.jws, kp2.publicKeyPem);
  assert.strictEqual(v.ok, false);
});

test("verify with tampered receipt fails (output_hash changed)", () => {
  const tampered = { ...receipt, output_hash: "c".repeat(64) };
  const v = verifyReceipt(tampered, signedR.jws, kp1.publicKeyPem);
  assert.strictEqual(v.ok, false);
});

test("verify with tampered JWS signature fails", () => {
  const parts = signedR.jws.split(".");
  // Flip first char of signature (last char's low bits are base64
  // padding for 64-byte Ed25519 sigs, so flipping it can be a no-op).
  const sigB64 = parts[2];
  const broken = (sigB64[0] === "A" ? "B" : "A") + sigB64.slice(1);
  const tamperedJws = `${parts[0]}.${parts[1]}.${broken}`;
  const v = verifyReceipt(receipt, tamperedJws, kp1.publicKeyPem);
  assert.strictEqual(v.ok, false);
});

test("two receipts with same content + key produce identical JWS", () => {
  // Ed25519 is deterministic — same input always produces same signature.
  const a = signReceipt(receipt, kp1.privateKeyPem);
  const b = signReceipt(receipt, kp1.privateKeyPem);
  assert.strictEqual(a.jws, b.jws);
  assert.strictEqual(a.receiptHash, b.receiptHash);
});

test("computeReceiptHash matches sign() result", () => {
  const h = computeReceiptHash(receipt);
  assert.strictEqual(h, signedR.receiptHash);
});

console.log(`\n[receipts.test.mjs] ${passed} passed, ${failed} failed.\n`);
process.exit(failed > 0 ? 1 : 0);
