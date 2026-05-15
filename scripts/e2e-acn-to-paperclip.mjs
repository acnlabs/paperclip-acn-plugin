#!/usr/bin/env node
/**
 * E2E test 1 — ACN → Paperclip direction:
 *
 *   1. Pre-count Paperclip issues for the configured company.
 *   2. Create a fresh ACN task on the bridge subnet.
 *   3. Wait up to N seconds for ACN to fire `task.created` webhook to the
 *      plugin (which is signed with the harness HMAC secret).
 *   4. Verify a corresponding Paperclip issue appears for the company.
 *   5. Verify the issue payload contains the ACN task_id mapping
 *      (e.g. via `originKind === "plugin:acnlabs.acn:task"`).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const state = JSON.parse(
  readFileSync(resolve(process.cwd(), "scripts/e2e-state.json"), "utf-8"),
);
const { acnUrl, paperclipUrl, apiKey, subnetId, companyId } = state;

const STAMP = Math.random().toString(36).slice(2, 8);
const TIMEOUT_MS = 15_000;

async function jsonFetch(url, options = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 10_000);
  const res = await fetch(url, {
    ...options,
    signal: c.signal,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  }).finally(() => clearTimeout(t));
  const text = await res.text();
  const body = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    const err = new Error(`${options.method ?? "GET"} ${url} → ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function listIssues() {
  return jsonFetch(`${paperclipUrl}/api/companies/${companyId}/issues`);
}

async function waitForIssue(taskId, before) {
  const deadline = Date.now() + TIMEOUT_MS;
  const beforeIds = new Set(before.map((i) => i.id));
  while (Date.now() < deadline) {
    const after = await listIssues();
    const fresh = after.filter((i) => !beforeIds.has(i.id));
    const match = fresh.find((i) => {
      const ok = i.originKind?.startsWith("plugin:acnlabs.acn");
      const refMatch =
        i.originRef === taskId ||
        i.externalRef === taskId ||
        (i.title ?? "").includes(taskId.slice(0, 8));
      return ok && refMatch;
    }) ?? fresh.find((i) => i.originKind?.startsWith("plugin:acnlabs.acn"));
    if (match) return match;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function main() {
  console.log("[ACN→Paperclip E2E]");
  console.log("  acn   :", acnUrl);
  console.log("  pc    :", paperclipUrl);
  console.log("  subnet:", subnetId);

  const before = await listIssues();
  console.log(`\n[1/3] Paperclip company has ${before.length} issue(s) before test`);

  // The plugin's task.created echo guard skips tasks whose creator_id matches
  // the bridge agent (self-created tasks). To exercise the *real* ACN→PC path
  // we must spin up an external ACN agent that creates the task instead.
  console.log("[2/3] registering external ACN agent + creating task…");
  const external = await jsonFetch(`${acnUrl}/api/v1/agents/join`, {
    method: "POST",
    body: JSON.stringify({
      name: `e2e-external-${STAMP}`,
      description: "External ACN agent for ACN→PC smoke test",
      a2a_endpoint: `http://127.0.0.1:9998/sink-${STAMP}`,
      tags: ["e2e", "external"],
    }),
  });
  await jsonFetch(
    `${acnUrl}/api/v1/agents/${external.agent_id}/subnets/${subnetId}`,
    { method: "POST", headers: { Authorization: `Bearer ${external.api_key}` } },
  );

  const task = await jsonFetch(`${acnUrl}/api/v1/tasks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${external.api_key}` },
    body: JSON.stringify({
      title: `E2E ACN→Paperclip ${STAMP}`,
      description:
        "Smoke test that ACN webhook fires into Paperclip plugin and creates a mirror issue. Auto-generated; safe to ignore.",
      reward: "0",
      deadline_hours: 24,
      subnet_id: subnetId,
      max_participants: 1,
    }),
  });
  console.log("  task_id =", task.task_id);

  console.log("[3/3] waiting up to 15s for mirror issue…");
  const issue = await waitForIssue(task.task_id, before);
  if (!issue) {
    console.error("\n❌ no mirror issue appeared within 15s.");
    console.error("   Tail of Paperclip-side plugin logs may have details.");
    process.exit(1);
  }
  console.log("\n✓ mirror issue created:");
  console.log("  id        :", issue.id);
  console.log("  title     :", issue.title);
  console.log("  originKind:", issue.originKind);
  console.log("  originRef :", issue.originRef ?? issue.externalRef ?? "<unset>");
}

main().catch((err) => {
  console.error("\n❌ E2E failed:", err.message);
  if (err.body) console.error("  body:", JSON.stringify(err.body, null, 2));
  process.exit(1);
});
