import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldSkipPluginEcho } from "../src/lib/echo-guard.js";

const PLUGIN_ID = "acnlabs.acn";

describe("shouldSkipPluginEcho", () => {
  it("skips events authored by any plugin (actorType signal)", () => {
    assert.equal(
      shouldSkipPluginEcho({ actorType: "plugin", payload: {} }, PLUGIN_ID),
      true,
    );
  });

  it("skips events whose payload.originKind names this plugin", () => {
    assert.equal(
      shouldSkipPluginEcho(
        { actorType: "user", payload: { originKind: "plugin:acnlabs.acn:task" } },
        PLUGIN_ID,
      ),
      true,
    );
  });

  it("does NOT skip events from other plugins via originKind", () => {
    assert.equal(
      shouldSkipPluginEcho(
        { actorType: "user", payload: { originKind: "plugin:other.vendor:thing" } },
        PLUGIN_ID,
      ),
      false,
    );
  });

  it("does NOT skip events from a sibling plugin whose id has ours as a prefix", () => {
    // Regression: startsWith("plugin:acnlabs.acn") would erroneously match
    // "plugin:acnlabs.acnplus:foo". The separator-aware check fixes this.
    assert.equal(
      shouldSkipPluginEcho(
        { actorType: "user", payload: { originKind: "plugin:acnlabs.acnplus:foo" } },
        PLUGIN_ID,
      ),
      false,
    );
  });

  it("skips an event whose originKind exactly equals plugin:<id>", () => {
    assert.equal(
      shouldSkipPluginEcho(
        { actorType: "user", payload: { originKind: "plugin:acnlabs.acn" } },
        PLUGIN_ID,
      ),
      true,
    );
  });

  it("does NOT skip events authored by the system actor", () => {
    assert.equal(
      shouldSkipPluginEcho({ actorType: "system", payload: {} }, PLUGIN_ID),
      false,
    );
  });

  it("does NOT skip events authored by a user", () => {
    assert.equal(
      shouldSkipPluginEcho({ actorType: "user", payload: {} }, PLUGIN_ID),
      false,
    );
  });

  it("does NOT skip events authored by an agent", () => {
    assert.equal(
      shouldSkipPluginEcho({ actorType: "agent", payload: {} }, PLUGIN_ID),
      false,
    );
  });

  it("handles events with no payload defensively", () => {
    assert.equal(shouldSkipPluginEcho({ actorType: "user" }, PLUGIN_ID), false);
    assert.equal(shouldSkipPluginEcho({}, PLUGIN_ID), false);
  });

  it("handles null originKind without throwing", () => {
    assert.equal(
      shouldSkipPluginEcho(
        { actorType: "user", payload: { originKind: null } },
        PLUGIN_ID,
      ),
      false,
    );
  });
});
