/**
 * Tests for resolveSecretOrLiteral / looksLikeSecretRef.
 *
 * Why this matters: Paperclip's current build refuses any UUID-shaped value
 * in plugin config (`PLUGIN_SECRET_REFS_DISABLED_MESSAGE`). For the plugin
 * to work today and continue working once that gate flips, the worker has to
 * accept BOTH a UUID secret-ref and a literal plaintext value. The decision
 * has to be made on shape, never on runtime errors, so a typoed UUID can't
 * silently leak plaintext to the host.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { looksLikeSecretRef, resolveSecretOrLiteral } from "../src/lib/secrets.ts";

describe("looksLikeSecretRef", () => {
  it("recognises canonical lowercase v4 UUID", () => {
    assert.equal(
      looksLikeSecretRef("30f28441-b6cc-453d-a0d5-d83a9bbb90fe"),
      true,
    );
  });

  it("recognises uppercase UUID", () => {
    assert.equal(
      looksLikeSecretRef("30F28441-B6CC-453D-A0D5-D83A9BBB90FE"),
      true,
    );
  });

  it("rejects ACN api keys (acn_ prefix)", () => {
    assert.equal(
      looksLikeSecretRef("acn_live_abcdef1234567890abcdef1234567890"),
      false,
    );
  });

  it("rejects 64-char hex HMAC secrets", () => {
    const hex64 = "a".repeat(64);
    assert.equal(looksLikeSecretRef(hex64), false);
  });

  it("rejects empty / short / dashy non-UUID strings", () => {
    assert.equal(looksLikeSecretRef(""), false);
    assert.equal(looksLikeSecretRef("acn-api-key"), false);
    assert.equal(looksLikeSecretRef("not-a-uuid-at-all"), false);
  });

  it("rejects UUID with extra surrounding whitespace or text", () => {
    assert.equal(
      looksLikeSecretRef(" 30f28441-b6cc-453d-a0d5-d83a9bbb90fe"),
      false,
    );
    assert.equal(
      looksLikeSecretRef("30f28441-b6cc-453d-a0d5-d83a9bbb90fe "),
      false,
    );
    assert.equal(
      looksLikeSecretRef("secret:30f28441-b6cc-453d-a0d5-d83a9bbb90fe"),
      false,
    );
  });
});

describe("resolveSecretOrLiteral", () => {
  it("delegates UUID-shaped refs to the host", async () => {
    let calledWith: string | null = null;
    const host = {
      async resolve(ref: string) {
        calledWith = ref;
        return "resolved-plaintext";
      },
    };
    const result = await resolveSecretOrLiteral(
      "30f28441-b6cc-453d-a0d5-d83a9bbb90fe",
      host,
    );
    assert.equal(result, "resolved-plaintext");
    assert.equal(calledWith, "30f28441-b6cc-453d-a0d5-d83a9bbb90fe");
  });

  it("returns literal values verbatim without touching the host", async () => {
    let touched = false;
    const host = {
      async resolve() {
        touched = true;
        return "should-not-happen";
      },
    };
    const result = await resolveSecretOrLiteral("acn_live_xyz", host);
    assert.equal(result, "acn_live_xyz");
    assert.equal(touched, false, "host.resolve must not be called for literals");
  });

  it("propagates host errors when the ref looks like a UUID", async () => {
    const host = {
      async resolve() {
        throw new Error("boom");
      },
    };
    await assert.rejects(
      () =>
        resolveSecretOrLiteral(
          "30f28441-b6cc-453d-a0d5-d83a9bbb90fe",
          host,
        ),
      /boom/,
    );
  });
});
