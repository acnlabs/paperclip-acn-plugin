import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  isHostedAcnBase,
  isPrivateOrLoopbackUrl,
  resolvePaperclipPublicBaseUrl,
  shouldAttemptHarnessRegister,
} from "../src/lib/public-base-url.ts";

describe("public-base-url", () => {
  it("detects loopback and private hosts", () => {
    assert.equal(isPrivateOrLoopbackUrl("http://127.0.0.1:3100"), true);
    assert.equal(isPrivateOrLoopbackUrl("http://localhost:3100"), true);
    assert.equal(isPrivateOrLoopbackUrl("http://192.168.1.2:3100"), true);
    assert.equal(isPrivateOrLoopbackUrl("https://pc.example.com"), false);
  });

  it("treats loopback ACN as non-hosted", () => {
    assert.equal(isHostedAcnBase("http://127.0.0.1:9000"), false);
    assert.equal(isHostedAcnBase("https://acn.acnlabs.cn"), true);
  });

  it("prefers config over env", () => {
    assert.equal(
      resolvePaperclipPublicBaseUrl({
        paperclipBaseUrl: "https://cfg.example/",
        envPublicUrl: "https://env.example",
      }),
      "https://cfg.example",
    );
    assert.equal(
      resolvePaperclipPublicBaseUrl({
        paperclipBaseUrl: "",
        envPublicUrl: "https://env.example/",
      }),
      "https://env.example",
    );
  });

  it("skips harness attempt for loopback against hosted ACN", () => {
    const r = shouldAttemptHarnessRegister({
      acnBaseUrl: "https://acn.acnlabs.cn",
      publicBaseUrl: "http://127.0.0.1:3100",
    });
    assert.equal(r.attempt, false);
    assert.equal(r.reason, "private_or_loopback");
  });

  it("allows loopback harness against local ACN", () => {
    const r = shouldAttemptHarnessRegister({
      acnBaseUrl: "http://127.0.0.1:9000",
      publicBaseUrl: "http://127.0.0.1:3100",
    });
    assert.equal(r.attempt, true);
  });
});
