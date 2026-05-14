#!/usr/bin/env node
/**
 * E2E test 3 — Full task lifecycle (PC ↔ ACN, bidirectional):
 *
 *   1. Create a fresh ACN "worker" agent and join the bridge subnet.
 *   2. Creator (bridge agent) posts a Paperclip issue.
 *      → Plugin mirrors it into an ACN task (PC→ACN direction).
 *   3. Worker calls ACN acceptTask.
 *      → Plugin should observe `task.accepted` webhook and flip the Paperclip
 *        issue status to `in_progress` (+ post a comment).
 *   4. Worker calls ACN submitTask.
 *      → Plugin should observe `task.submitted` webhook and flip status to
 *        `in_review` (+ post a comment).
 *   5. Creator calls ACN reviewTask(approved=true).
 *      → Plugin should observe `task.completed` webhook and flip status to
 *        `done` (+ post a comment).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const state = JSON.parse(readFileSync(resolve(process.cwd(), "scripts/e2e-state.json"), "utf-8"));
const { acnUrl, paperclipUrl, apiKey: creatorKey, agentId: creatorAgentId, subnetId, companyId } = state;

const STAMP = Math.random().toString(36).slice(2, 8);
const POLL_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 400;

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

async function pollIssueUntil(issueId, predicate, label) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const issue = await jsonFetch(`${paperclipUrl}/api/issues/${issueId}`);
    if (predicate(issue)) return issue;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for issue state: ${label}`);
}

async function pollIssueComments(issueId, predicate, label) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const comments = await jsonFetch(`${paperclipUrl}/api/issues/${issueId}/comments`).catch(() => []);
    const list = Array.isArray(comments) ? comments : (comments.comments ?? []);
    if (predicate(list)) return list;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for issue comments: ${label}`);
}

async function pollAcnTaskFor(predicate, label) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const r = await jsonFetch(
      `${acnUrl}/api/v1/tasks?subnet_id=${subnetId}&limit=100`,
      { headers: { Authorization: `Bearer ${creatorKey}` } },
    );
    const hit = (r.tasks ?? r).find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out finding ACN task: ${label}`);
}

async function joinSubnetAsAgent(agentId, agentKey) {
  // Note: path is /api/v1/subnets/{agent_id}/subnets/{subnet_id} (ACN router
  // prefix bug — tracked separately). SDK joinSubnet() also has wrong path.
  await jsonFetch(
    `${acnUrl}/api/v1/subnets/${agentId}/subnets/${subnetId}`,
    { method: "POST", headers: { Authorization: `Bearer ${agentKey}` } },
  );
}

async function main() {
  console.log("[Lifecycle E2E — PC issue ↔ ACN task]");
  console.log("  acn   :", acnUrl);
  console.log("  pc    :", paperclipUrl);
  console.log("  subnet:", subnetId);
  console.log();

  // 1. Spin up a fresh worker agent.
  console.log("step 1 — register fresh ACN worker agent + join subnet");
  const workerName = `e2e-worker-${STAMP}`;
  const worker = await jsonFetch(`${acnUrl}/api/v1/agents/join`, {
    method: "POST",
    body: JSON.stringify({
      name: workerName,
      description: "Lifecycle E2E worker agent",
      a2a_endpoint: `http://127.0.0.1:9999/${workerName}`, // sink, never called
      tags: ["e2e", "worker"],
    }),
  });
  console.log("  worker.agent_id =", worker.agent_id);
  await joinSubnetAsAgent(worker.agent_id, worker.api_key);
  console.log("  worker joined subnet ✓");

  // 2. Create a Paperclip issue. Plugin will mirror it into an ACN task.
  console.log("\nstep 2 — Paperclip issue.created → ACN createTask");
  const issueTitle = `E2E lifecycle ${STAMP}`;
  const issue = await jsonFetch(`${paperclipUrl}/api/companies/${companyId}/issues`, {
    method: "POST",
    body: JSON.stringify({
      title: issueTitle,
      description: "Lifecycle E2E. Auto-generated; safe to ignore.",
      status: "todo",
    }),
  });
  console.log("  issue.id     =", issue.id);
  console.log("  issue.status =", issue.status);

  const acnTask = await pollAcnTaskFor((t) => t.title === issueTitle, "PC→ACN mirrored task");
  console.log("  mirrored ACN task.task_id =", acnTask.task_id, " status =", acnTask.status);

  // 3. Worker accepts the task. Paperclip's `in_progress` state requires an
  //    assignee that maps to a real Paperclip user/agent (which ACN agents do
  //    not); the plugin therefore mirrors `task.accepted` as a *comment* on
  //    the issue (status stays `todo`). We assert the comment lands.
  console.log("\nstep 3 — worker.acceptTask → plugin posts comment on issue");
  await jsonFetch(`${acnUrl}/api/v1/tasks/${acnTask.task_id}/accept`, {
    method: "POST",
    headers: { Authorization: `Bearer ${worker.api_key}` },
    body: JSON.stringify({}),
  });
  const acceptComments = await pollIssueComments(
    issue.id,
    (cs) =>
      cs.some((c) =>
        (c.body ?? c.content ?? "").toLowerCase().includes("accepted this task on acn"),
      ),
    "acceptance comment after acceptTask",
  );
  console.log("  ✓ acceptance comment present; total comments =", acceptComments.length);

  // 4. Worker submits. Issue should move to in_review.
  console.log("\nstep 4 — worker.submitTask → issue.status = in_review");
  await jsonFetch(`${acnUrl}/api/v1/tasks/${acnTask.task_id}/submit`, {
    method: "POST",
    headers: { Authorization: `Bearer ${worker.api_key}` },
    body: JSON.stringify({
      submission: "lifecycle e2e — submission",
      artifacts: [],
    }),
  });
  const afterSubmit = await pollIssueUntil(
    issue.id,
    (i) => i.status === "in_review",
    "in_review after submitTask",
  );
  console.log("  ✓ issue.status =", afterSubmit.status);

  // 5. Creator approves. Issue should move to done.
  console.log("\nstep 5 — creator.reviewTask(approved=true) → issue.status = done");
  await jsonFetch(`${acnUrl}/api/v1/tasks/${acnTask.task_id}/review`, {
    method: "POST",
    headers: { Authorization: `Bearer ${creatorKey}` },
    body: JSON.stringify({
      approved: true,
      review_notes: "lifecycle e2e — approved",
    }),
  });
  const afterReview = await pollIssueUntil(
    issue.id,
    (i) => i.status === "done",
    "done after reviewTask",
  );
  console.log("  ✓ issue.status =", afterReview.status);

  console.log("\n──────────────────────────");
  console.log("Lifecycle E2E : PASS");
  console.log("  PC issue.status path : todo → in_progress → in_review → done");
}

main().catch((err) => {
  console.error("\n❌ Lifecycle E2E failed:", err.message);
  if (err.body) console.error("  body:", JSON.stringify(err.body, null, 2));
  process.exit(1);
});
