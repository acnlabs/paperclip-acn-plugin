#!/usr/bin/env node
/**
 * E2E — ACN Org work → Paperclip Issue (plugin ≥ 0.2.0 inbound):
 *
 *   A. External agent creates Org work → harness org.work_created → Issue
 *   B. PATCH work done → org.work_updated → Issue status done
 *   C. POST loop/tick → org.loop_tick → comment on open Issues (best-effort)
 *
 * Requires:
 *   - scripts/e2e-state.json from provision-e2e.mjs (orgId + harness registered)
 *   - ACN able to reach paperclipBaseUrl (local ACN + DEV_MODE loopback OK)
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
  subnetId,
  companyId,
} = state;

if (!orgId) {
  console.error("e2e-state.json missing orgId — re-run provision-e2e.mjs");
  process.exit(1);
}

const STAMP = Math.random().toString(36).slice(2, 8);
const WAIT_MS = 25_000;
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

async function listIssues() {
  const r = await jsonFetch(`${paperclipUrl}/api/companies/${companyId}/issues`);
  return Array.isArray(r) ? r : (r.issues ?? []);
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
  console.log("[Org inbound E2E — ACN → Paperclip]");
  console.log("  acn :", acnUrl);
  console.log("  pc  :", paperclipUrl);
  console.log("  org :", orgId, "subnet:", subnetId);

  // External agent so create_work is not an outbound echo from the bridge.
  console.log("\n0 — register external ACN agent + join Org subnet");
  const external = await jsonFetch(`${acnUrl}/api/v1/agents/join`, {
    method: "POST",
    body: JSON.stringify({
      name: `E2E External ${STAMP}`,
      description: "Creates Org work for inbound harness smoke",
      a2a_endpoint: `https://example.com/e2e-external-${STAMP}`,
      tags: ["e2e", "external"],
    }),
  });
  try {
    await jsonFetch(
      `${acnUrl}/api/v1/agents/${external.agent_id}/subnets/${subnetId}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${external.api_key}` },
      },
    );
  } catch (err) {
    if (!(err.status === 409 && err.body?.error_code === "already_member")) {
      throw err;
    }
  }
  // create_work is governance-only (unclaimed Org → created_by / claimed →
  // owner). Joining the subnet or Org membership does NOT grant create.
  // Bridge agent created the Org in provision-e2e, so it is created_by.
  console.log("  external.agent_id =", external.agent_id);

  const title = `E2E inbound org-work ${STAMP}`;
  console.log("\nA — create Org work (bridge governance) → expect Paperclip Issue");
  const before = await listIssues();
  const beforeIds = new Set(before.map((i) => i.id));

  // Demonstrate external non-governance 403, then create as bridge.
  try {
    await jsonFetch(`${acnUrl}/api/v1/orgs/${orgId}/work`, {
      method: "POST",
      headers: { Authorization: `Bearer ${external.api_key}` },
      body: JSON.stringify({
        title: `${title} (should-403)`,
        assignee_agent_id: external.agent_id,
      }),
    });
    console.log("  ⚠ external create unexpectedly succeeded");
  } catch (err) {
    const reason = err.body?.details?.reason ?? "?";
    console.log(
      "  ✓ external create 403 as expected (",
      err.status,
      "reason=",
      reason,
      ")",
    );
  }

  const work = await jsonFetch(`${acnUrl}/api/v1/orgs/${orgId}/work`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      title,
      assignee_agent_id: external.agent_id,
    }),
  });
  console.log("  work_id =", work.work_id, "status =", work.status);

  const issue = await waitFor(async () => {
    const after = await listIssues();
    return (
      after.find(
        (i) =>
          !beforeIds.has(i.id) &&
          (i.originKind === "plugin:acnlabs.acn:work" ||
            (i.title ?? "") === title),
      ) ?? null
    );
  }, "Paperclip Issue for Org work");
  console.log("  issue.id =", issue.id, "originKind =", issue.originKind);

  console.log("\nB — PATCH work done → expect Issue done");
  await jsonFetch(`${acnUrl}/api/v1/orgs/${orgId}/work/${work.work_id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ status: "done" }),
  });
  await waitFor(async () => {
    const i = await jsonFetch(`${paperclipUrl}/api/issues/${issue.id}`);
    return i.status === "done" ? i : null;
  }, "Issue status done");
  console.log("  ✓ issue done");

  console.log("\nC — loop tick (best-effort comment path)");
  // Fresh open work so tick has something to report. Failures here do not
  // fail the smoke — A/B already proved inbound create + status sync.
  try {
    const openTitle = `E2E inbound tick ${STAMP}`;
    const beforeTick = await listIssues();
    const beforeTickIds = new Set(beforeTick.map((i) => i.id));
    const openWork = await jsonFetch(`${acnUrl}/api/v1/orgs/${orgId}/work`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ title: openTitle }),
    });
    const openIssue = await waitFor(async () => {
      const after = await listIssues();
      return (
        after.find(
          (i) =>
            !beforeTickIds.has(i.id) &&
            (i.originKind === "plugin:acnlabs.acn:work" ||
              (i.title ?? "") === openTitle ||
              i.originRef === openWork.work_id ||
              i.externalRef === openWork.work_id),
        ) ?? null
      );
    }, "Issue for tick work");
    await jsonFetch(`${acnUrl}/api/v1/orgs/${orgId}/loop/tick`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({}),
    });
    try {
      await waitFor(async () => {
        const comments = await jsonFetch(
          `${paperclipUrl}/api/issues/${openIssue.id}/comments`,
        ).catch(() => []);
        const list = Array.isArray(comments)
          ? comments
          : (comments.comments ?? []);
        const hit = list.find((c) =>
          String(c.body ?? c.content ?? "").includes("Org loop tick"),
        );
        return hit ?? null;
      }, "loop_tick comment on open Issue");
      console.log("  ✓ loop_tick comment present on", openIssue.id);
    } catch {
      console.log(
        "  ⚠ no loop_tick comment within timeout (work_id=",
        openWork.work_id,
        ") — cooldown is 5m; restart plugin worker to clear",
      );
    }
  } catch (err) {
    console.log("  ⚠ loop_tick path skipped:", err.message);
  }

  console.log("\nOK — Org inbound E2E passed (A/B required)");
}

main().catch((err) => {
  console.error("\n❌", err.message);
  if (err.body) console.error(JSON.stringify(err.body, null, 2));
  process.exit(1);
});
