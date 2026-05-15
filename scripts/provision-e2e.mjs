#!/usr/bin/env node
/**
 * One-shot provisioner for the paperclip-acn-plugin E2E smoke.
 *
 * Steps:
 *  1. Register a long-lived "paperclip-bridge" agent on ACN → grab api_key.
 *  2. Create an ACN subnet owned by that agent.
 *  3. Generate a random 32-byte hex harness HMAC secret.
 *  4. Upsert 2 secrets in Paperclip (acn-api-key, acn-harness-secret) on the
 *     ACN PoC Company.
 *  5. POST plugin config to Paperclip so the worker picks up the new values
 *     (which also triggers registerSubnetHarness on the ACN side).
 *
 * Idempotent: re-running creates a fresh agent + subnet (no name reuse) and
 * overwrites the secrets and plugin config in place.
 *
 * Env overrides:
 *   ACN_URL              default http://127.0.0.1:9000
 *   PAPERCLIP_URL        default http://127.0.0.1:3100
 *   PAPERCLIP_COMPANY_ID default 5e6a3397-fb99-4899-aeb1-c6f8b2396e9a (ACN PoC Company)
 *   PLUGIN_KEY           default acnlabs.acn
 *
 * Output: writes the resolved IDs/keys to scripts/e2e-state.json so other
 *         smoke scripts can pick them up without re-provisioning.
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
  const bridge = await jsonFetch(`${ACN_URL}/api/v1/agents/join`, {
    method: "POST",
    body: JSON.stringify({
      name: `paperclip-bridge-${stamp}`,
      description:
        "Long-lived bridge agent used by paperclip-acn-plugin to mirror ACN tasks into Paperclip issues. Auto-provisioned for local E2E smoke.",
      a2a_endpoint: `${PAPERCLIP_URL}/api/plugins/${PLUGIN_KEY}/webhooks/acn`,
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
      name: `paperclip-e2e-${stamp}`,
      description: "E2E smoke subnet for paperclip-acn-plugin",
    }),
  });
  console.log("  subnet_id =", subnet.subnet_id);

  // ── 2b. Bridge joins its own subnet ─────────────────────────────────────
  // ACN treats subnet owner ≠ subnet member: GET /tasks/{id} on a private
  // task requires membership, so the bridge needs to explicitly join even
  // though it created the subnet. Tracked as separate ACN backend TODO.
  step("bridge joins subnet (workaround for owner-not-member)");
  // Canonical agent-side route since ACN backend PR #42 / acn-client 0.11.2.
  await jsonFetch(`${ACN_URL}/api/v1/agents/${bridge.agent_id}/subnets/${subnet.subnet_id}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bridge.api_key}` },
  });

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
    acnSubnetId: subnet.subnet_id,
    acnApiKeyRef: bridge.api_key,
    acnHarnessSecretRef: harnessSecret,
    paperclipBaseUrl: PAPERCLIP_URL,
    autoCreateIssues: true,
    autoApproveOnDone: false,
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
    subnetId: subnet.subnet_id,
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
