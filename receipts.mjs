// Verifiable Execution Receipts — bridge-side primitives (R29 v0.2.1, Mike directive 2026-05-07).
//
// Every outbound room message carries a JWS receipt signed by the local
// device's Ed25519 private key. The receipt commits to:
//   - room_id, passport_did, device_key_id
//   - bridge_version, message_id
//   - model+provider snapshot (operator-declared at mint time)
//   - prompt_hash, tool_call_transcript_hash, output_hash
//   - capability_scope, server_nonce, timestamp, previous_receipt_hash
//
// Encoding: JCS (RFC 8785) — Maat's R29 catch. Cross-language verifiers
// (Python, Rust, Go) must produce the same canonical bytes; raw
// concatenation creates ambiguity. JCS is the standard.
//
// Signing: Ed25519 (RFC 8032). Node has built-in support via crypto.sign
// with key.type === 'private'/'public' and 'ed25519' key type — no
// external library required.
//
// Module exports:
//   generateDeviceKeypair()
//   jcsCanonicalize(obj)
//   computeReceiptHash(receiptObj)
//   signReceipt(receiptObj, privateKeyPem)   → { jws, receiptHash, canonicalBytes }
//   verifyReceipt(receiptObj, jws, publicKeyPem) → { ok, reason? }
//   keyIdFromPublicKeyPem(publicKeyPem)

import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify, createHash } from "crypto";

// ── Ed25519 keypair generation ──────────────────────────────────────────────
// Returns PEM-encoded private + public keys. Private must be persisted
// to the OS Keychain (macOS) or a 0600 file (Linux). Public is registered
// with the platform via /api/devices/pair/claim.
//
// key_id = first 16 hex chars of sha256(public_key_pem). Used as the index
// into device_keys table; verifiers fetch the public key by key_id.
//
// fingerprint = full 64-char sha256 hex of public_key_pem. Used for human-
// readable display in the dashboard's "Signing key" card.
export function generateDeviceKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const fingerprint = createHash("sha256").update(publicKeyPem).digest("hex");
  const keyId = fingerprint.slice(0, 16);
  return { publicKeyPem, privateKeyPem, keyId, fingerprint };
}

export function keyIdFromPublicKeyPem(publicKeyPem) {
  return createHash("sha256").update(publicKeyPem).digest("hex").slice(0, 16);
}

// ── JCS (RFC 8785) JSON Canonicalization Scheme ────────────────────────────
// Implementation matches the reference: object keys sorted lexicographically
// by code-unit (UTF-16), no whitespace, numbers in shortest round-tripping
// form, strings escape only required characters.
//
// We keep the implementation compact and self-contained — no external dep
// (existing dep is just `ws`). Validated against the JCS test vectors at
// https://github.com/cyberphone/json-canonicalization/tree/master/testdata.

function jcsString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x09) out += "\\t";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0d) out += "\\r";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += s[i];
  }
  return out + '"';
}

function jcsNumber(n) {
  if (!Number.isFinite(n)) {
    throw new Error("JCS: cannot serialize non-finite number");
  }
  if (Number.isInteger(n)) return String(n);
  // Use the same ECMAScript ToString algorithm RFC 8785 references —
  // JS's Number.prototype.toString() implements it.
  return n.toString();
}

export function jcsCanonicalize(value) {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return jcsNumber(value);
  if (typeof value === "string") return jcsString(value);
  if (Array.isArray(value)) {
    return "[" + value.map(jcsCanonicalize).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort((a, b) => {
      // Sort by UTF-16 code units (default JS sort). RFC 8785 § 3.2.3.
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return "{" + keys.map(k => jcsString(k) + ":" + jcsCanonicalize(value[k])).join(",") + "}";
  }
  throw new Error(`JCS: unsupported type ${typeof value}`);
}

// ── Receipt hash ────────────────────────────────────────────────────────────
// receipt_hash = sha256(JCS(receipt_object)). Maat's R29 split: the
// platform's Merkle leaf commits to (content || receipt_hash || jws),
// so verifiers can prove "what was signed" matches "what was anchored"
// without re-canonicalizing the receipt.
export function computeReceiptHash(receiptObj) {
  const canonical = jcsCanonicalize(receiptObj);
  return createHash("sha256").update(canonical).digest("hex");
}

// ── JWS Compact Serialization (Ed25519) ─────────────────────────────────────
// Format: base64url(header) "." base64url(payload) "." base64url(signature)
// Header: { alg: "EdDSA", typ: "JWS", kid: "<keyId>" }
// Payload: the JCS-canonicalized receipt bytes
//
// We use the JWS Compact form so verifiers can extract header/payload/sig
// with a simple split + decode, consistent with RFC 7515.

function b64urlEncode(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

export function signReceipt(receiptObj, privateKeyPem) {
  const canonical = jcsCanonicalize(receiptObj);
  const receiptHash = createHash("sha256").update(canonical).digest("hex");
  const keyId = computeKeyIdFromPrivate(privateKeyPem);
  const header = { alg: "EdDSA", typ: "JWS", kid: keyId };
  const headerB64 = b64urlEncode(JSON.stringify(header));
  const payloadB64 = b64urlEncode(canonical);
  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
  const privateKey = createPrivateKey({ key: privateKeyPem, format: "pem" });
  // Node's crypto.sign(null, data, key) does Ed25519 signing when key is ed25519.
  const sig = cryptoSign(null, signingInput, privateKey);
  const sigB64 = b64urlEncode(sig);
  const jws = `${headerB64}.${payloadB64}.${sigB64}`;
  return { jws, receiptHash, canonicalBytes: canonical };
}

export function verifyReceipt(receiptObj, jws, publicKeyPem) {
  try {
    const parts = jws.split(".");
    if (parts.length !== 3) return { ok: false, reason: "JWS must have 3 parts" };
    const [headerB64, payloadB64, sigB64] = parts;
    const header = JSON.parse(b64urlDecode(headerB64).toString("utf8"));
    if (header.alg !== "EdDSA") return { ok: false, reason: `unsupported alg: ${header.alg}` };
    const expectedKid = keyIdFromPublicKeyPem(publicKeyPem);
    if (header.kid && header.kid !== expectedKid) {
      return { ok: false, reason: `kid mismatch: header=${header.kid} expected=${expectedKid}` };
    }
    // Payload must match the JCS-canonicalized receipt — protects against
    // someone signing a different object than the one we're verifying.
    const expectedPayload = jcsCanonicalize(receiptObj);
    const actualPayload = b64urlDecode(payloadB64).toString("utf8");
    if (actualPayload !== expectedPayload) {
      return { ok: false, reason: "payload does not match canonicalized receipt" };
    }
    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
    const publicKey = createPublicKey({ key: publicKeyPem, format: "pem" });
    const sig = b64urlDecode(sigB64);
    const ok = cryptoVerify(null, signingInput, publicKey, sig);
    return ok ? { ok: true } : { ok: false, reason: "signature verification failed" };
  } catch (err) {
    return { ok: false, reason: `verify error: ${err.message}` };
  }
}

function computeKeyIdFromPrivate(privateKeyPem) {
  // Derive public key from private key, then compute keyId from that public key.
  const privateKey = createPrivateKey({ key: privateKeyPem, format: "pem" });
  const publicKey = createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return keyIdFromPublicKeyPem(publicKeyPem);
}
