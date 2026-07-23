#!/usr/bin/env node
/**
 * One-shot provisioner for the paperclip-acn-plugin E2E smoke.
 *
 * Steps:
 *  1. Register a long-lived bridge agent on ACN → grab api_key.
 *  2. Create an ACN subnet owned by that agent (join if needed).
 *  2c. Create an ACN Org fenced on that subnet (Work Port / builtin_work).
 *  3. Generate a random 32-byte hex harness HMAC secret.
 *  4. Upsert 2 secrets in Paperclip (acn-api-key, acn-harness-secret) on the
 *     ACN PoC Company.
 *  5. POST plugin config (acnOrgId + autoApproveOnDone) so the worker can
 *     mirror Issue ↔ Org work (harness register needs a public paperclipBaseUrl).
 *
 * Idempotent: re-running creates a fresh agent + subnet + Org and
 * overwrites the secrets and plugin config in place.
 *
 * Env overrides:
 *   ACN_URL                   default http://127.0.0.1:9000
 *   PAPERCLIP_URL             default http://127.0.0.1:3100
 *   PAPERCLIP_COMPANY_ID      default 5e6a3397-fb99-4899-aeb1-c6f8b2396e9a
 *   PLUGIN_KEY                default acnlabs.acn
 *   ACN_BRIDGE_A2A_ENDPOINT   override join a2a_endpoint (required public when
 *                             PAPERCLIP_URL is loopback against hosted ACN)
 *
 * Output: writes IDs/keys (including orgId) to scripts/e2e-state.json for
 *         scripts/e2e-org-work.mjs and legacy smokes.
 */

import crypto from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ACN_URL = process.env.ACN_URL ?? "http://127.0.0.1:9000";
const PAPERCLIP_URL = process.env.PAPERCLIP_URL ?? "http://127.0.0.1:3100";
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID ?? "5e6a3397-fb99-4899-aeb1-c6f8b2396e9a";
const PLUGIN_KEY = process.env.PLUGIN_KEY ?? "acnlabs.acn";

const stamp = Math.random().toString(36).slice(2, 8);

async function jsonFetch(url, options = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10_000);
  const res = await fetch(url, {
    ...options,
    signal: controller.signal,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  }).finally(() => clearTimeout(t));
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = new Error(`${options.method ?? "GET"} ${url} → ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function step(name) {
  console.log(`\n[${name}]`);
}

async function main() {
  // ── 1. Register ACN agent ───────────────────────────────────────────────
  step("register ACN bridge agent");
  // a2a_endpoint must be a publicly reachable URL when talking to hosted ACN
  // (private/loopback hosts are rejected). Harness webhook URL is registered
  // separately via paperclipBaseUrl; use a sink endpoint here for join.
  const a2aEndpoint =
    process.env.ACN_BRIDGE_A2A_ENDPOINT ??
    (PAPERCLIP_URL.includes("127.0.0.1") || PAPERCLIP_URL.includes("localhost")
      ? `https://example.com/paperclip-bridge-sink/${stamp}`
      : `${PAPERCLIP_URL}/api/plugins/${PLUGIN_KEY}/webhooks/acn`);
  const bridge = await jsonFetch(`${ACN_URL}/api/v1/agents/join`, {
    method: "POST",
    body: JSON.stringify({
      name: `Paperclip Bridge ${stamp}`,
      description:
        "Long-lived bridge agent used by paperclip-acn-plugin to mirror ACN Org work into Paperclip issues. Auto-provisioned for local E2E smoke.",
      a2a_endpoint: a2aEndpoint,
      tags: ["bridge", "paperclip"],
    }),
  });
  console.log("  agent_id =", bridge.agent_id);

  // ── 2. Create subnet (owned by bridge) ──────────────────────────────────
  step("create ACN subnet");
  const subnet = await jsonFetch(`${ACN_URL}/api/v1/subnets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bridge.api_key}` },
    body: JSON.stringify({
      name: `Paperclip E2E ${stamp}`,
      description: "E2E smoke subnet for paperclip-acn-plugin",
    }),
  });
  const subnetId = subnet.slug ?? subnet.subnet_id;
  if (!subnetId) {
    throw new Error(`subnet create missing slug/subnet_id: ${JSON.stringify(subnet)}`);
  }
  console.log("  subnet_id =", subnetId);

  // ── 2b. Bridge joins its own subnet ─────────────────────────────────────
  // ACN treats subnet owner ≠ subnet member: GET /tasks/{id} on a private
  // task requires membership, so the bridge needs to explicitly join even
  // though it created the subnet. Tracked as separate ACN backend TODO.
  step("bridge joins subnet (workaround for owner-not-member)");
  // Canonical agent-side route since ACN backend PR #42 / acn-client 0.11.2.
  // Hosted ACN may already treat subnet creator as a member → 409 is fine.
  try {
    await jsonFetch(`${ACN_URL}/api/v1/agents/${bridge.agent_id}/subnets/${subnetId}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bridge.api_key}` },
    });
  } catch (err) {
    if (err.status === 409 && err.body?.error_code === "already_member") {
      console.log("  already a member — ok");
    } else {
      throw err;
    }
  }

  // ── 2c. Create Org (Work Port default: builtin_work) ────────────────────
  step("create ACN Org for Paperclip company");
  const org = await jsonFetch(`${ACN_URL}/api/v1/orgs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bridge.api_key}` },
    body: JSON.stringify({
      display_name: `Paperclip E2E ${stamp}`,
      subnet_id: subnetId,
    }),
  });
  console.log("  org_id =", org.org_id);

  // ── 3. Generate harness secret ──────────────────────────────────────────
  const harnessSecret = crypto.randomBytes(32).toString("hex");

  // ── 4. Upsert Paperclip secrets ─────────────────────────────────────────
  step("create/refresh Paperclip secrets");
  const existing = await jsonFetch(
    `${PAPERCLIP_URL}/api/companies/${COMPANY_ID}/secrets`,
  );
  async function upsertSecret(key, value, description) {
    const stale = existing.filter((s) => s.key === key);
    for (const s of stale) {
      await jsonFetch(`${PAPERCLIP_URL}/api/secrets/${s.id}`, {
        method: "DELETE",
      });
    }
    const created = await jsonFetch(
      `${PAPERCLIP_URL}/api/companies/${COMPANY_ID}/secrets`,
      {
        method: "POST",
        body: JSON.stringify({
          name: key,
          key,
          value,
          description,
        }),
      },
    );
    return created;
  }
  const apiKeySecret = await upsertSecret(
    "acn-api-key",
    bridge.api_key,
    "ACN bridge agent API key (auto-provisioned by paperclip-acn-plugin/scripts/provision-e2e.mjs).",
  );
  const harnessSecretRow = await upsertSecret(
    "acn-harness-secret",
    harnessSecret,
    "ACN harness webhook HMAC secret (auto-provisioned).",
  );
  console.log("  secret acn-api-key id        =", apiKeySecret.id);
  console.log("  secret acn-harness-secret id =", harnessSecretRow.id);

  // ── 5. POST plugin config ───────────────────────────────────────────────
  step("upsert plugin config");
  // Paperclip's current build hard-disables plugin secret-refs
  // (`PLUGIN_SECRET_REFS_DISABLED_MESSAGE`). The plugin worker now accepts
  // either a UUID secret-ref OR a literal plaintext value via
  // `resolveSecretOrLiteral` (see src/lib/secrets.ts). For now we pass
  // literals. When upstream lifts the gate, switch back to {apiKeySecret.id}
  // / {harnessSecretRow.id} — no plugin code change required.
  const configJson = {
    acnBaseUrl: ACN_URL,
    acnSubnetId: subnetId,
    acnOrgId: org.org_id,
    acnApiKeyRef: bridge.api_key,
    acnHarnessSecretRef: harnessSecret,
    paperclipBaseUrl: PAPERCLIP_URL,
    autoCreateIssues: true,
    // Legacy Task Pool → Issue mirror is off by default. Set
    // ENABLE_LEGACY_TASK_MIRROR=1 when running scripts/e2e-acn-to-paperclip.mjs.
    enableLegacyTaskMirror: process.env.ENABLE_LEGACY_TASK_MIRROR === "1",
    autoApproveOnDone: true,
  };
  const cfgRes = await jsonFetch(
    `${PAPERCLIP_URL}/api/plugins/${PLUGIN_KEY}/config`,
    {
      method: "POST",
      body: JSON.stringify({ configJson }),
    },
  );
  console.log("  config persisted, id =", cfgRes.id ?? cfgRes.pluginId ?? "<n/a>");

  // ── 6. Persist state for downstream smoke scripts ───────────────────────
  const state = {
    agentId: bridge.agent_id,
    apiKey: bridge.api_key,
    subnetId,
    orgId: org.org_id,
    harnessSecret,
    companyId: COMPANY_ID,
    pluginKey: PLUGIN_KEY,
    acnUrl: ACN_URL,
    paperclipUrl: PAPERCLIP_URL,
    createdAt: new Date().toISOString(),
  };
  const out = resolve(process.cwd(), "scripts/e2e-state.json");
  writeFileSync(out, JSON.stringify(state, null, 2) + "\n");
  console.log("\n✓ provisioned. state written to", out);
}

main().catch((err) => {
  console.error("\n❌ provision failed:", err.message);
  if (err.body) console.error("  body:", JSON.stringify(err.body, null, 2));
  process.exit(1);
});
