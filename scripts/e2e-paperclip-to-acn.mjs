#!/usr/bin/env node
/**
 * E2E test 2 — Paperclip → ACN direction + echo-guard regression:
 *
 *   PART A. User creates a Paperclip issue.
 *           Plugin should observe `issue.created`, call ACN createTask,
 *           and persist the mapping.
 *
 *   PART B. Echo guard sanity. Plugin's own mirror issues (created from
 *           ACN webhooks in the other direction) MUST NOT re-trigger
 *           createTask. We exercise this by:
 *             1. Counting ACN tasks in the bridge subnet.
 *             2. Creating an ACN task from outside (simulating an external
 *                ACN client). The plugin will mirror it into a Paperclip
 *                issue. Without echo-guard, that mirror issue would fire
 *                issue.created and the plugin would re-create another ACN
 *                task, looping.
 *             3. Re-counting ACN tasks: must increase by exactly 1.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const state = JSON.parse(
  readFileSync(resolve(process.cwd(), "scripts/e2e-state.json"), "utf-8"),
);
const { acnUrl, paperclipUrl, apiKey, subnetId, companyId } = state;

const STAMP = Math.random().toString(36).slice(2, 8);
const WAIT_MS = 10_000;

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

async function listAcnTasks() {
  const r = await jsonFetch(
    `${acnUrl}/api/v1/tasks?subnet_id=${subnetId}&limit=100`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  return r.tasks ?? r;
}

async function waitForAcnTaskMatching(predicate) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const tasks = await listAcnTasks();
    const hit = tasks.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function listIssues() {
  return jsonFetch(`${paperclipUrl}/api/companies/${companyId}/issues`);
}

async function waitForIssueMatching(predicate) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const list = await listIssues();
    const hit = list.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

async function partA() {
  console.log("\n=== PART A — Paperclip issue.created → ACN createTask ===");
  const before = await listAcnTasks();
  console.log(`  ACN tasks in subnet before: ${before.length}`);

  const expectedTitle = `E2E PC→ACN ${STAMP}`;
  console.log(`  creating Paperclip issue "${expectedTitle}"…`);
  const issue = await jsonFetch(`${paperclipUrl}/api/companies/${companyId}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: expectedTitle,
      description:
        "Smoke test that Paperclip issue.created event triggers ACN createTask. Auto-generated; safe to ignore.",
      status: "todo",
    }),
  });
  console.log("  issue.id =", issue.id);

  const acnTask = await waitForAcnTaskMatching(
    (t) => t.title === expectedTitle,
  );
  if (!acnTask) {
    console.error("  ❌ no matching ACN task appeared within 10s");
    return false;
  }
  console.log("  ✓ ACN task mirrored:");
  console.log("    task_id =", acnTask.task_id);
  console.log("    status  =", acnTask.status);
  console.log("    reward  =", acnTask.reward, "(string)");

  const after = await listAcnTasks();
  if (after.length !== before.length + 1) {
    console.error(
      `  ❌ ACN task count grew by ${after.length - before.length}, expected 1 (possible echo loop)`,
    );
    return false;
  }
  return true;
}

async function partB() {
  console.log("\n=== PART B — Echo guard (ACN mirror must NOT re-loop) ===");
  const before = await listAcnTasks();
  console.log(`  ACN tasks in subnet before: ${before.length}`);

  const expectedTitle = `E2E echo-guard ${STAMP}`;

  // PART B needs an *external* ACN agent so the plugin's creator_id-based
  // echo guard does not skip the task we're trying to mirror.
  console.log("  registering external ACN agent for echo-guard probe…");
  const external = await jsonFetch(`${acnUrl}/api/v1/agents/join`, {
    method: "POST",
    body: JSON.stringify({
      name: `e2e-echo-ext-${STAMP}`,
      description: "External ACN agent for echo-guard regression",
      a2a_endpoint: `http://127.0.0.1:9997/sink-${STAMP}`,
      tags: ["e2e", "external"],
    }),
  });
  await jsonFetch(
    `${acnUrl}/api/v1/agents/${external.agent_id}/subnets/${subnetId}`,
    { method: "POST", headers: { Authorization: `Bearer ${external.api_key}` } },
  );

  console.log(`  creating ACN task from external client "${expectedTitle}"…`);
  const created = await jsonFetch(`${acnUrl}/api/v1/tasks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${external.api_key}` },
    body: JSON.stringify({
      title: expectedTitle,
      description:
        "Smoke test: plugin must mirror this into a Paperclip issue without echoing back another ACN task.",
      reward: "0",
      deadline_hours: 24,
      subnet_id: subnetId,
      max_participants: 1,
    }),
  });
  console.log("  created.task_id =", created.task_id);

  const mirrorIssue = await waitForIssueMatching(
    (i) =>
      i.originKind === "plugin:acnlabs.acn:task" &&
      (i.title ?? "").includes(expectedTitle),
  );
  if (!mirrorIssue) {
    console.error("  ❌ mirror issue did not appear");
    return false;
  }
  console.log("  ✓ mirror issue appeared:", mirrorIssue.id);

  // Give the plugin ~3s after mirror creation to (incorrectly) loop back.
  await new Promise((r) => setTimeout(r, 3_000));

  const after = await listAcnTasks();
  const delta = after.length - before.length;
  if (delta !== 1) {
    console.error(
      `  ❌ ACN tasks grew by ${delta}, expected exactly 1 — echo loop suspected.`,
    );
    return false;
  }
  console.log("  ✓ ACN tasks grew by exactly 1 (no echo loop)");
  return true;
}

async function main() {
  console.log("[Paperclip→ACN + echo-guard E2E]");
  console.log("  acn   :", acnUrl, "subnet:", subnetId);
  console.log("  pc    :", paperclipUrl);

  const aOk = await partA();
  const bOk = await partB();

  console.log("\n──────────────────────────");
  console.log("PART A  PC→ACN createTask :", aOk ? "PASS" : "FAIL");
  console.log("PART B  echo guard        :", bOk ? "PASS" : "FAIL");
  if (!(aOk && bOk)) process.exit(1);
}

main().catch((err) => {
  console.error("\n❌ E2E failed:", err.message);
  if (err.body) console.error("  body:", JSON.stringify(err.body, null, 2));
  process.exit(1);
});
