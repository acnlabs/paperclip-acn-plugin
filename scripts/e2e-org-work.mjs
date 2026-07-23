#!/usr/bin/env node
/**
 * E2E — Paperclip Issue ↔ ACN Org work (plugin ≥ 0.2.0):
 *
 *   A. Human creates Issue → plugin POST /orgs/{id}/work
 *   B. Issue → done (autoApproveOnDone) → PATCH work status=done
 *
 * Requires scripts/e2e-state.json from provision-e2e.mjs (with orgId).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const state = JSON.parse(
  readFileSync(resolve(process.cwd(), "scripts/e2e-state.json"), "utf-8"),
);
const {
  acnUrl,
  paperclipUrl,
  apiKey,
  orgId,
  companyId,
} = state;

if (!orgId) {
  console.error("e2e-state.json missing orgId — re-run provision-e2e.mjs (0.2 Org path)");
  process.exit(1);
}

const STAMP = Math.random().toString(36).slice(2, 8);
const WAIT_MS = 20_000;
const POLL_MS = 500;

async function jsonFetch(url, options = {}) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 15_000);
  const res = await fetch(url, {
    ...options,
    signal: c.signal,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  }).finally(() => clearTimeout(t));
  const text = await res.text();
  const body = text
    ? (() => {
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      })()
    : null;
  if (!res.ok) {
    const err = new Error(`${options.method ?? "GET"} ${url} → ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function listOrgWork() {
  const r = await jsonFetch(`${acnUrl}/api/v1/orgs/${orgId}/work`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return r.items ?? r.work_items ?? r.work ?? r;
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline) {
    const hit = await predicate();
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  throw new Error(`timed out: ${label}`);
}

async function main() {
  console.log("[Org work E2E — Issue ↔ builtin_work]");
  console.log("  acn :", acnUrl);
  console.log("  pc  :", paperclipUrl);
  console.log("  org :", orgId);

  const title = `E2E org-work ${STAMP}`;
  console.log("\nA — create Issue → expect Org work");
  const issue = await jsonFetch(
    `${paperclipUrl}/api/companies/${companyId}/issues`,
    {
      method: "POST",
      body: JSON.stringify({
        title,
        description: "Org work smoke (0.2). Safe to ignore.",
        status: "todo",
      }),
    },
  );
  console.log("  issue.id =", issue.id);

  const work = await waitFor(async () => {
    const items = await listOrgWork();
    const list = Array.isArray(items) ? items : [];
    return list.find((w) => (w.title ?? "") === title) ?? null;
  }, "Org work with matching title");
  console.log("  work_id =", work.work_id, "status =", work.status);

  console.log("\nB — Issue done → expect work status=done");
  await jsonFetch(`${paperclipUrl}/api/issues/${issue.id}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "done" }),
  });

  const done = await waitFor(async () => {
    const items = await listOrgWork();
    const list = Array.isArray(items) ? items : [];
    const w = list.find((x) => x.work_id === work.work_id);
    return w?.status === "done" ? w : null;
  }, "work status done");
  console.log("  ✓ work done:", done.work_id);

  console.log("\nOK — Org work E2E passed");
}

main().catch((err) => {
  console.error("\n❌", err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
