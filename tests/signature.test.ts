import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { verifyAcnSignature } from "../src/lib/signature.js";

const SECRET = "test-secret-32-chars-of-entropy-yes";
const BODY = '{"event":"task.created","task_id":"t_1","data":{"status":"open"}}';

function signWith(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

describe("verifyAcnSignature", () => {
  it("returns true when no secret is configured (opt-out mode)", () => {
    assert.equal(verifyAcnSignature({}, BODY, null), true);
  });

  it("accepts a valid HMAC-SHA256 signature", () => {
    const sig = signWith(SECRET, BODY);
    assert.equal(verifyAcnSignature({ "x-acn-signature": sig }, BODY, SECRET), true);
  });

  it("is case-insensitive on the header name", () => {
    const sig = signWith(SECRET, BODY);
    assert.equal(verifyAcnSignature({ "X-ACN-Signature": sig }, BODY, SECRET), true);
    assert.equal(verifyAcnSignature({ "X-Acn-Signature": sig }, BODY, SECRET), true);
  });

  it("rejects when the header is missing", () => {
    assert.equal(verifyAcnSignature({}, BODY, SECRET), false);
  });

  it("rejects when the body has been tampered with", () => {
    const sig = signWith(SECRET, BODY);
    assert.equal(
      verifyAcnSignature({ "x-acn-signature": sig }, BODY + "x", SECRET),
      false,
    );
  });

  it("rejects when signed with a different secret", () => {
    const sig = signWith("other-secret", BODY);
    assert.equal(
      verifyAcnSignature({ "x-acn-signature": sig }, BODY, SECRET),
      false,
    );
  });

  it("accepts a bare hex digest (no sha256= prefix) for forward compat", () => {
    const sig = signWith(SECRET, BODY).slice(7); // strip "sha256="
    assert.equal(
      verifyAcnSignature({ "x-acn-signature": sig }, BODY, SECRET),
      true,
    );
  });

  it("rejects when the digest length is wrong", () => {
    assert.equal(
      verifyAcnSignature({ "x-acn-signature": "sha256=deadbeef" }, BODY, SECRET),
      false,
    );
  });

  it("rejects malformed hex without crashing", () => {
    assert.equal(
      verifyAcnSignature({ "x-acn-signature": "sha256=" + "Z".repeat(64) }, BODY, SECRET),
      false,
    );
  });

  it("picks the first value when the header is an array", () => {
    const sig = signWith(SECRET, BODY);
    assert.equal(
      verifyAcnSignature({ "x-acn-signature": [sig, "sha256=bad"] }, BODY, SECRET),
      true,
    );
  });
});
