/**
 * ACN Plugin Worker
 *
 * Responsibilities:
 *  P0-1  Startup  : resolve/create ACN Org; register subnet harness webhook
 *  P0-2  Startup  : full sync — pull open ACN tasks → Paperclip issues (legacy)
 *  P0-3  ACN→PC   : task.* webhook events → sync Paperclip issue status / comments (legacy)
 *  P0-4  PC→ACN   : Paperclip issue done/cancelled → ACN task review (legacy)
 *  P2c-C1 PC→ACN  : Paperclip issue created → Org work (NOT Task Pool)
 *  P2c-C2 ACN→PC  : org.work_* / org.loop_tick → Issues (preferred inbound)
 *  P2c-C3 PC→ACN  : Paperclip issue done/cancelled → PATCH Org work status
 */

import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { ACNClient, type Task } from "acn-client";
import { PLUGIN_ID, STATE_KEYS, WEBHOOK_KEYS } from "./constants.js";
import { ACNError, AcnOrgApi, orgSubnetId } from "./lib/org-api.js";
import { verifyAcnSignature } from "./lib/signature.js";
import { shouldSkipPluginEcho } from "./lib/echo-guard.js";
import { resolveSecretOrLiteral } from "./lib/secrets.js";

// ── Config ────────────────────────────────────────────────────────────────────

export interface PluginConfig {
  acnBaseUrl?: string;
  paperclipBaseUrl?: string;
  acnApiKeyRef?: string;
  /** Secret ref for the HMAC-SHA256 secret shared with ACN's harness webhook. */
  acnHarnessSecretRef?: string;
  /** Org Harness org_id; auto-created + persisted when empty. */
  acnOrgId?: string;
  acnSubnetId?: string;
  autoCreateIssues?: boolean;
  autoApproveOnDone?: boolean;
}

// ── ACN webhook event payload ─────────────────────────────────────────────────

/**
 * Envelope sent by ACN's WebhookService (WebhookPayload model).
 *
 * For Org Harness events, `task_id` is overloaded to carry `org_id` — always
 * read work/org fields from `data`, never treat `task_id` as a Task Pool id
 * when `event` starts with `org.`.
 */
interface AcnHarnessEventPayload {
  event: string;
  timestamp?: string;
  /** Task Pool task id, or org_id for org.* events (legacy field name). */
  task_id?: string;
  data: {
    // Shared / task.*
    status?: string;
    creator_id?: string;
    assignee_id?: string;
    reward?: string;
    reward_currency?: string;
    subnet_id?: string;
    max_participants?: number;
    participation_id?: string;
    participant_id?: string;
    participant_name?: string;
    participation_status?: string;
    resubmit_count?: number;
    max_resubmit_attempts?: number;
    rejection_reason?: string;
    // org.*
    org_id?: string;
    work_id?: string;
    title?: string;
    assignee_agent_id?: string | null;
    open_count?: number;
    work_ids?: string[];
    assignees?: string[];
  };
}

// ── Module-level worker state (populated once in setup) ───────────────────────
// onWebhook() is a sibling lifecycle hook without its own ctx, so the handler
// is stashed here after setup() resolves.

let _ctx: PluginContext | null = null;
let _cfg: PluginConfig | null = null;
let _client: ACNClient | null = null;
/** Resolved HMAC secret for verifying X-ACN-Signature on inbound webhooks. */
let _harnessSecret: string | null = null;
/**
 * ACN agent_id of the API key the plugin is configured with. Used to detect
 * — and skip — webhook events fired for tasks the plugin itself just
 * created (legacy Task path).
 */
let _selfAgentId: string | null = null;
/**
 * work_ids successfully mapped after C1 outbound. Covers async/retry
 * deliveries that arrive after `saveMap` (ACN may retry after sync POST fails).
 */
const _recentOutboundWorkIds = new Set<string>();
const RECENT_OUTBOUND_CAP = 200;

/**
 * In-flight Paperclip→ACN creates. ACN `create_work` awaits harness POST
 * before returning, so `org.work_created` is handled *during* `createWork`
 * — before we know `work_id`. Bind to this issue instead of creating a twin.
 */
type PendingOutbound = { issueId: string; title: string };
const _pendingOutboundByCompany = new Map<string, PendingOutbound[]>();

/** Mark a work_id as outbound so late/retry org.work_created skips create. */
export function noteRecentOutboundWork(workId: string): void {
  _recentOutboundWorkIds.add(workId);
  if (_recentOutboundWorkIds.size > RECENT_OUTBOUND_CAP) {
    const first = _recentOutboundWorkIds.values().next().value;
    if (first !== undefined) _recentOutboundWorkIds.delete(first);
  }
}

/** Drop a work_id from the echo set (e.g. after saveMap failure). */
export function forgetRecentOutboundWork(workId: string): void {
  _recentOutboundWorkIds.delete(workId);
}

/** Register an in-flight outbound create before awaiting createWork. */
export function beginOutboundWorkCreate(
  companyId: string,
  issueId: string,
  title: string,
): void {
  const stack = _pendingOutboundByCompany.get(companyId) ?? [];
  stack.push({ issueId, title });
  _pendingOutboundByCompany.set(companyId, stack);
}

/** Clear in-flight entry after createWork settles (success or failure). */
export function endOutboundWorkCreate(companyId: string, issueId: string): void {
  const stack = _pendingOutboundByCompany.get(companyId);
  if (!stack?.length) return;
  const idx = stack.findIndex((p) => p.issueId === issueId);
  if (idx >= 0) stack.splice(idx, 1);
  if (stack.length === 0) _pendingOutboundByCompany.delete(companyId);
  else _pendingOutboundByCompany.set(companyId, stack);
}

function peekPendingOutbound(companyId: string): PendingOutbound | undefined {
  const stack = _pendingOutboundByCompany.get(companyId);
  if (!stack?.length) return undefined;
  return stack[stack.length - 1];
}

/** Test helper — clear outbound echo + in-flight stacks. */
export function clearRecentOutboundWorkForTests(): void {
  _recentOutboundWorkIds.clear();
  _pendingOutboundByCompany.clear();
  _lastLoopTickCommentAt = 0;
}

/** Cooldown so loop_tick does not spam issue comments. */
const LOOP_TICK_COMMENT_COOLDOWN_MS = 5 * 60 * 1000;
let _lastLoopTickCommentAt = 0;

// ── State helpers ─────────────────────────────────────────────────────────────

type StateMap = Record<string, string>;

async function loadMap(ctx: PluginContext, key: string, companyId: string): Promise<StateMap> {
  // Paperclip's plugin_state.value_json is a jsonb column, so the host can
  // return either a parsed object or a JSON string depending on how the
  // value was originally written. Accept both shapes — naively assuming
  // string and JSON.parse-ing on an object yielded an empty map and silently
  // broke task-id ↔ issue-id round trips for every event handler.
  const raw = await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: key });
  if (!raw) return {};
  try {
    return typeof raw === "string" ? (JSON.parse(raw) as StateMap) : (raw as StateMap);
  } catch {
    return {};
  }
}

async function saveMap(ctx: PluginContext, key: string, companyId: string, map: StateMap): Promise<void> {
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: key },
    JSON.stringify(map),
  );
}

async function loadScalar(
  ctx: PluginContext,
  key: string,
  companyId: string,
): Promise<string | null> {
  const raw = await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: key });
  if (raw == null || raw === "") return null;
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s || s === "null") return null;
    // Historically some hosts JSON-encode scalars.
    if (s.startsWith('"') && s.endsWith('"')) {
      try {
        const parsed = JSON.parse(s) as unknown;
        return typeof parsed === "string" && parsed ? parsed : null;
      } catch {
        return s;
      }
    }
    return s;
  }
  return null;
}

async function saveScalar(
  ctx: PluginContext,
  key: string,
  companyId: string,
  value: string,
): Promise<void> {
  await ctx.state.set(
    { scopeKind: "company", scopeId: companyId, stateKey: key },
    value,
  );
}

/** Reverse-lookup: find the key whose value equals `val` */
function reverseLookup(map: StateMap, val: string): string | undefined {
  return Object.entries(map).find(([, v]) => v === val)?.[0];
}

/**
 * Resolve configured / persisted Org, or create one bound to ``acnSubnetId``.
 * Mutates ``cfg.acnOrgId`` / ``cfg.acnSubnetId`` when filled from Org record.
 *
 * On ``subnet_already_bound`` (409): if the error body hints a ``org_…`` id,
 * reuse it; otherwise fail with an operator-facing message to set ``acnOrgId``.
 */
export async function resolveAcnOrg(
  ctx: PluginContext,
  cfg: PluginConfig,
  orgApi: AcnOrgApi,
  companyId: string | undefined,
  companyName: string | undefined,
): Promise<string> {
  let orgId = (cfg.acnOrgId ?? "").trim();
  if (!orgId && companyId) {
    orgId = (await loadScalar(ctx, STATE_KEYS.acnOrgId, companyId)) ?? "";
  }

  if (orgId) {
    const org = await orgApi.getOrg(orgId);
    const fence = orgSubnetId(org);
    const configuredSubnet = (cfg.acnSubnetId ?? "").trim();
    if (fence && configuredSubnet && fence !== configuredSubnet) {
      ctx.logger.warn(
        "acn-plugin: acnSubnetId does not match Org fence — using Org fence for harness",
        {
          acnOrgId: org.org_id,
          configured_subnet: configuredSubnet,
          org_fence: fence,
        },
      );
      cfg.acnSubnetId = fence;
    } else if (fence && !configuredSubnet) {
      cfg.acnSubnetId = fence;
    }
    cfg.acnOrgId = org.org_id;
    if (companyId) {
      await saveScalar(ctx, STATE_KEYS.acnOrgId, companyId, org.org_id);
    }
    return org.org_id;
  }

  const subnet = (cfg.acnSubnetId ?? "").trim();
  if (!subnet) {
    throw new Error(
      "acnOrgId or acnSubnetId required: set an existing Org, or a subnet to create one",
    );
  }

  const displayName =
    (companyName && companyName.trim()) ||
    (companyId ? `Paperclip ${companyId}` : "Paperclip Org");

  try {
    const created = await orgApi.createOrg({
      display_name: displayName,
      subnet_id: subnet,
    });
    cfg.acnOrgId = created.org_id;
    if (companyId) {
      await saveScalar(ctx, STATE_KEYS.acnOrgId, companyId, created.org_id);
    }
    ctx.logger.info("acn-plugin: created ACN Org for company", {
      org_id: created.org_id,
      subnet_id: subnet,
      company_id: companyId,
    });
    return created.org_id;
  } catch (err) {
    if (err instanceof ACNError && err.status === 409) {
      const hint = err.boundOrgIdHint;
      if (hint) {
        ctx.logger.warn(
          "acn-plugin: subnet already bound — reusing bound Org from error hint",
          { subnet_id: subnet, org_id: hint, reason: err.reason },
        );
        const org = await orgApi.getOrg(hint);
        cfg.acnOrgId = org.org_id;
        const fence = orgSubnetId(org);
        if (fence) cfg.acnSubnetId = fence;
        if (companyId) {
          await saveScalar(ctx, STATE_KEYS.acnOrgId, companyId, org.org_id);
        }
        return org.org_id;
      }
      throw new Error(
        `Subnet '${subnet}' is already bound to an ACN Org (reason=${err.reason ?? "conflict"}). ` +
          `Set instance config acnOrgId to that org_id and restart the plugin. ` +
          `Original: ${err.message}`,
      );
    }
    throw err;
  }
}

// ── ACN client factory ────────────────────────────────────────────────────────

function buildClient(cfg: PluginConfig, apiKey: string): ACNClient {
  return new ACNClient({
    baseUrl: cfg.acnBaseUrl ?? "https://api.acnlabs.dev",
    apiKey,
  });
}

/** Construct the Paperclip webhook URL for ACN harness registration. */
function harnessWebhookUrl(cfg: PluginConfig): string | null {
  if (!cfg.paperclipBaseUrl) return null;
  const base = cfg.paperclipBaseUrl.replace(/\/$/, "");
  return `${base}/api/plugins/${PLUGIN_ID}/webhooks/${WEBHOOK_KEYS.acnEvents}`;
}

// ── Issue body helpers ────────────────────────────────────────────────────────

function taskIssueDescription(task: Task): string {
  const lines: string[] = [task.description ?? ""];
  lines.push("", `**ACN Task ID:** \`${task.task_id}\``);
  const rewardVal = parseFloat(task.reward ?? "0");
  if (rewardVal > 0) {
    lines.push(`**Reward:** ${task.reward} ${task.reward_currency ?? ""}`);
  }
  return lines.join("\n");
}

// ── Full sync helpers ─────────────────────────────────────────────────────────

async function syncTasks(
  ctx: PluginContext,
  client: ACNClient,
  cfg: PluginConfig,
  companyId: string,
  taskIssueMap: StateMap,
): Promise<StateMap> {
  // ACN task statuses (mirrors backend `TaskStatus` enum): open | in_progress
  // | submitted | completed | rejected | cancelled. We sync everything that
  // is not yet terminal.
  const [openRes, inProgressRes, submittedRes] = await Promise.all([
    client.listTasks({ status: "open", limit: 100 }),
    client.listTasks({ status: "in_progress", limit: 100 }),
    client.listTasks({ status: "submitted", limit: 100 }),
  ]);
  const allTasks = [...openRes.tasks, ...inProgressRes.tasks, ...submittedRes.tasks];
  const updated = { ...taskIssueMap };

  for (const task of allTasks) {
    const taskSubnet =
      (task as Task & { subnet_id?: string | null }).subnet_slug ??
      (task as Task & { subnet_id?: string | null }).subnet_id;
    if (taskSubnet !== cfg.acnSubnetId) continue;
    if (updated[task.task_id]) continue;

    try {
      const issue = await ctx.issues.create({
        companyId,
        title: `[ACN] ${task.title}`,
        description: taskIssueDescription(task),
        status: "todo",
        originKind: `plugin:${PLUGIN_ID}:task` as `plugin:${string}`,
        originId: task.task_id,
      });
      updated[task.task_id] = issue.id;
      ctx.logger.info("acn-plugin: synced task → issue", {
        task_id: task.task_id,
        issue_id: issue.id,
      });
    } catch (err) {
      ctx.logger.warn("acn-plugin: failed to create issue for task", {
        task_id: task.task_id,
        error: String(err),
      });
    }
  }

  return updated;
}

// ── Org work inbound (P2c-C2) ─────────────────────────────────────────────────

function workIssueDescription(data: AcnHarnessEventPayload["data"]): string {
  const lines: string[] = [];
  if (data.work_id) lines.push(`**ACN Work ID:** \`${data.work_id}\``);
  if (data.org_id) lines.push(`**ACN Org ID:** \`${data.org_id}\``);
  if (data.assignee_agent_id) {
    lines.push(`**Assignee:** \`${data.assignee_agent_id}\``);
  }
  return lines.join("\n");
}

function configuredOrgId(cfg: PluginConfig): string {
  return (cfg.acnOrgId ?? "").trim();
}

export async function handleOrgWorkCreated(
  ctx: PluginContext,
  cfg: PluginConfig,
  companyId: string,
  data: AcnHarnessEventPayload["data"],
): Promise<void> {
  const orgId = configuredOrgId(cfg);
  const eventOrgId = (data.org_id ?? "").trim();
  if (!orgId || !eventOrgId || eventOrgId !== orgId) {
    ctx.logger.debug("acn-plugin: org.work_created skipped — org mismatch", {
      event_org: eventOrgId || null,
      configured_org: orgId || null,
    });
    return;
  }

  const workId = (data.work_id ?? "").trim();
  if (!workId) return;

  if (_recentOutboundWorkIds.has(workId)) {
    ctx.logger.info("acn-plugin: skipping org.work_created (outbound echo)", {
      work_id: workId,
    });
    return;
  }

  const workMap = await loadMap(ctx, STATE_KEYS.issueWorkMap, companyId);
  if (workMap[workId]) {
    ctx.logger.info("acn-plugin: skipping org.work_created (already mapped)", {
      work_id: workId,
      issue_id: workMap[workId],
    });
    return;
  }

  // Sync harness: bind to the Paperclip issue currently inside createWork.
  const pending = peekPendingOutbound(companyId);
  if (pending) {
    try {
      const fresh = await loadMap(ctx, STATE_KEYS.issueWorkMap, companyId);
      fresh[workId] = pending.issueId;
      await saveMap(ctx, STATE_KEYS.issueWorkMap, companyId, fresh);
      noteRecentOutboundWork(workId);
      ctx.logger.info("acn-plugin: org.work_created → bound to in-flight issue", {
        work_id: workId,
        issue_id: pending.issueId,
        org_id: orgId,
      });
    } catch (err) {
      forgetRecentOutboundWork(workId);
      ctx.logger.error("acn-plugin: failed to bind org.work_created to in-flight issue", {
        work_id: workId,
        issue_id: pending.issueId,
        error: String(err),
      });
    }
    return;
  }

  if (!cfg.autoCreateIssues) return;

  const issue = await ctx.issues.create({
    companyId,
    title: `[ACN] ${data.title ?? workId}`,
    description: workIssueDescription(data),
    status: "todo",
    originKind: `plugin:${PLUGIN_ID}:work` as `plugin:${string}`,
    originId: workId,
  });
  try {
    const fresh = await loadMap(ctx, STATE_KEYS.issueWorkMap, companyId);
    fresh[workId] = issue.id;
    await saveMap(ctx, STATE_KEYS.issueWorkMap, companyId, fresh);
    noteRecentOutboundWork(workId);
    ctx.logger.info("acn-plugin: org.work_created → issue created", {
      work_id: workId,
      issue_id: issue.id,
      org_id: orgId,
    });
  } catch (err) {
    forgetRecentOutboundWork(workId);
    ctx.logger.error("acn-plugin: org.work_created issue created but map persist failed", {
      work_id: workId,
      issue_id: issue.id,
      error: String(err),
    });
  }
}

export async function handleOrgWorkUpdated(
  ctx: PluginContext,
  cfg: PluginConfig,
  companyId: string,
  data: AcnHarnessEventPayload["data"],
): Promise<void> {
  const orgId = configuredOrgId(cfg);
  const eventOrgId = (data.org_id ?? "").trim();
  if (!orgId || !eventOrgId || eventOrgId !== orgId) return;

  const workId = (data.work_id ?? "").trim();
  if (!workId) return;

  const workMap = await loadMap(ctx, STATE_KEYS.issueWorkMap, companyId);
  const issueId = workMap[workId];
  if (!issueId) return;

  const status = data.status;
  if (!status) return;

  // Same constraint as task.accepted: Paperclip in_progress needs an assignee
  // in Paperclip's identity space — ACN agent ids are not assignable.
  if (status === "in_progress") {
    const who = data.assignee_agent_id ?? "unknown";
    await ctx.issues.createComment(
      issueId,
      `Org work moved to \`in_progress\` on ACN (assignee \`${who}\`).`,
      companyId,
    );
    ctx.logger.info("acn-plugin: org.work_updated → comment (in_progress)", {
      work_id: workId,
      issue_id: issueId,
    });
    return;
  }

  if (status === "todo" || status === "done" || status === "cancelled") {
    await ctx.issues.update(issueId, { status }, companyId);
    await ctx.issues.createComment(
      issueId,
      `Org work status on ACN is now \`${status}\`.`,
      companyId,
    );
    ctx.logger.info("acn-plugin: org.work_updated → issue status", {
      work_id: workId,
      issue_id: issueId,
      status,
    });
  }
}

export async function handleOrgLoopTick(
  ctx: PluginContext,
  cfg: PluginConfig,
  companyId: string,
  data: AcnHarnessEventPayload["data"],
): Promise<void> {
  const orgId = configuredOrgId(cfg);
  const eventOrgId = (data.org_id ?? "").trim();
  if (!orgId || !eventOrgId || eventOrgId !== orgId) return;

  const workIds = Array.isArray(data.work_ids) ? data.work_ids : [];
  const openCount = data.open_count ?? workIds.length;
  ctx.logger.info("acn-plugin: org.loop_tick", {
    org_id: orgId,
    open_count: openCount,
    work_ids: workIds,
  });

  if (workIds.length === 0) return;

  const now = Date.now();
  if (now - _lastLoopTickCommentAt < LOOP_TICK_COMMENT_COOLDOWN_MS) {
    return;
  }

  const workMap = await loadMap(ctx, STATE_KEYS.issueWorkMap, companyId);
  // One comment per tick (first mapped open work) to avoid comment spam.
  for (const workId of workIds) {
    const issueId = workMap[workId];
    if (!issueId) continue;
    await ctx.issues.createComment(
      issueId,
      `Org loop tick — ${openCount} open work item(s) on ACN.`,
      companyId,
    );
    _lastLoopTickCommentAt = now;
    break;
  }
}

// ── ACN webhook event handler ─────────────────────────────────────────────────

async function handleAcnWebhook(
  ctx: PluginContext,
  cfg: PluginConfig,
  client: ACNClient,
  rawBody: string,
): Promise<void> {
  let payload: AcnHarnessEventPayload;
  try {
    payload = JSON.parse(rawBody) as AcnHarnessEventPayload;
  } catch {
    ctx.logger.warn("acn-plugin: received unparseable webhook body");
    return;
  }
  if (!payload.event) return;

  ctx.logger.info("acn-plugin: received ACN event", { event: payload.event });

  const companies = await ctx.companies.list();
  const companyId = companies[0]?.id;
  if (!companyId) return;

  const { data } = payload;

  // Preferred Org Harness path (P2c-C2) — must run before task.* so we never
  // treat the overloaded task_id (org_id) as a Task Pool id.
  if (payload.event === "org.work_created") {
    await handleOrgWorkCreated(ctx, cfg, companyId, data);
    return;
  }
  if (payload.event === "org.work_updated") {
    await handleOrgWorkUpdated(ctx, cfg, companyId, data);
    return;
  }
  if (payload.event === "org.loop_tick") {
    await handleOrgLoopTick(ctx, cfg, companyId, data);
    return;
  }
  if (payload.event.startsWith("org.")) {
    ctx.logger.debug("acn-plugin: unhandled org event", { event: payload.event });
    return;
  }

  const task_id = payload.task_id ?? "";
  if (!task_id) return;

  const taskIssueMap = await loadMap(ctx, STATE_KEYS.issueTaskMap, companyId);

  switch (payload.event) {
    case "task.created": {
      if (!cfg.autoCreateIssues) break;
      if (taskIssueMap[task_id]) break;
      // Echo guard: skip tasks the bridge agent itself created. The plugin's
      // legacy outbound path also called ACN createTask synchronously,
      // which fires this very `task.created` webhook *before* `saveMap` has
      // had a chance to persist the mapping. The map check above will miss
      // and we'd ghost-mirror our own outbound task back into a second
      // Paperclip issue. Comparing against `_selfAgentId` closes that race.
      if (_selfAgentId && data.creator_id === _selfAgentId) {
        ctx.logger.info("acn-plugin: skipping task.created (self-created, echo guard)", {
          task_id,
        });
        break;
      }

      const task = await client.getTask(task_id).catch(() => null);
      if (!task) break;

      const issue = await ctx.issues.create({
        companyId,
        title: `[ACN] ${task.title ?? task_id}`,
        description: taskIssueDescription(task),
        status: "todo",
        originKind: `plugin:${PLUGIN_ID}:task` as `plugin:${string}`,
        originId: task_id,
      });
      taskIssueMap[task_id] = issue.id;
      await saveMap(ctx, STATE_KEYS.issueTaskMap, companyId, taskIssueMap);
      ctx.logger.info("acn-plugin: task.created → issue created", {
        task_id,
        issue_id: issue.id,
      });
      break;
    }

    case "task.accepted": {
      const issueId = taskIssueMap[task_id];
      if (!issueId) break;
      // Paperclip's `in_progress` status requires either an `assigneeUserId`
      // or `assigneeAgentId` — neither of which exists in ACN's identity
      // space. Pushing the ACN agent_id directly would fail Paperclip's
      // `assertAssignableAgent` check. We therefore record the acceptance as
      // a comment and leave the issue status as-is; users see the activity
      // and the Paperclip status moves on `task.submitted` (in_review) and
      // `task.completed` (done), which carry no assignee requirement.
      await ctx.issues.createComment(
        issueId,
        `Agent \`${data.assignee_id ?? "unknown"}\` accepted this task on ACN.`,
        companyId,
      );
      ctx.logger.info("acn-plugin: task.accepted → comment posted", {
        task_id,
        issue_id: issueId,
        assignee_id: data.assignee_id,
      });
      break;
    }

    case "task.submitted": {
      const issueId = taskIssueMap[task_id];
      if (!issueId) break;
      await ctx.issues.update(issueId, { status: "in_review" }, companyId);
      await ctx.issues.createComment(
        issueId,
        [
          `**Submission received** — open the **ACN tab** on this issue to review and approve or reject.`,
        ].join("\n"),
        companyId,
      );
      break;
    }

    case "task.completed": {
      const issueId = taskIssueMap[task_id];
      if (!issueId) break;
      await ctx.issues.update(issueId, { status: "done" }, companyId);
      await ctx.issues.createComment(issueId, "Task completed and payment settled via ACN.", companyId);
      break;
    }

    case "task.rejected": {
      const issueId = taskIssueMap[task_id];
      if (!issueId) break;
      await ctx.issues.update(issueId, { status: "cancelled" }, companyId);
      await ctx.issues.createComment(issueId, "ACN task was rejected by the creator.", companyId);
      break;
    }

    case "task.cancelled": {
      const issueId = taskIssueMap[task_id];
      if (!issueId) break;
      await ctx.issues.update(issueId, { status: "cancelled" }, companyId);
      await ctx.issues.createComment(issueId, "ACN task was cancelled.", companyId);
      break;
    }

    case "participation.rejected": {
      const issueId = taskIssueMap[task_id];
      if (!issueId) break;
      const parts = [
        `Submission rejected (attempt ${data.resubmit_count ?? "?"}/${data.max_resubmit_attempts ?? "?"}) — agent will resubmit.`,
      ];
      if (data.rejection_reason) parts.push(`\n**Reason:** ${data.rejection_reason}`);
      await ctx.issues.createComment(issueId, parts.join(""), companyId);
      break;
    }

    default:
      ctx.logger.debug("acn-plugin: unhandled task event", { event: payload.event });
  }
}

// ── Paperclip issue event handlers ────────────────────────────────────────────

export async function handleIssueUpdated(
  ctx: PluginContext,
  cfg: PluginConfig,
  client: ACNClient,
  orgApi: AcnOrgApi,
  event: PluginEvent,
): Promise<void> {
  if (shouldSkipPluginEcho(event, PLUGIN_ID)) return;

  // See handleIssueCreated: Paperclip carries the issue id on the event
  // envelope, while `payload` holds the change summary (status, previousStatus,
  // identifier, ...). There is no nested `changes` object — fields are flat.
  if (event.entityType !== "issue" || !event.entityId) return;
  const issueId = event.entityId;

  const payload = (event.payload ?? {}) as { status?: string };
  const status = payload.status;
  if (!status) return;
  if (status !== "done" && status !== "cancelled") return;

  const companyId = event.companyId;
  const orgId = (cfg.acnOrgId ?? "").trim();

  // P2c-C3: Org-backed issues → PATCH work status (preferred path).
  const workMap = await loadMap(ctx, STATE_KEYS.issueWorkMap, companyId);
  const workId = reverseLookup(workMap, issueId);
  if (workId && orgId) {
    if (status === "done" && !cfg.autoApproveOnDone) {
      ctx.logger.info("acn-plugin: skip Org work done — autoApproveOnDone=false", {
        work_id: workId,
        issue_id: issueId,
      });
      return;
    }
    try {
      await orgApi.updateWorkStatus(orgId, workId, { status });
      ctx.logger.info("acn-plugin: issue status → Org work PATCH", {
        work_id: workId,
        org_id: orgId,
        issue_id: issueId,
        status,
      });
    } catch (err) {
      ctx.logger.error("acn-plugin: Org work status PATCH failed", {
        work_id: workId,
        org_id: orgId,
        issue_id: issueId,
        status,
        error: String(err),
      });
    }
    return;
  }

  // Legacy Task Pool review path.
  const taskIssueMap = await loadMap(ctx, STATE_KEYS.issueTaskMap, companyId);
  const taskId = reverseLookup(taskIssueMap, issueId);
  if (!taskId) return;

  // Only call /review when ACN considers the task to be awaiting review
  // (`submitted`). For other statuses (open / in_progress / completed /...)
  // the review endpoint will 400.
  const acnTask = await client.getTask(taskId).catch(() => null);
  if (!acnTask || acnTask.status !== "submitted") return;

  if (status === "done" && cfg.autoApproveOnDone) {
    try {
      await client.reviewTask(taskId, true, "Approved via Paperclip");
      ctx.logger.info("acn-plugin: auto-approved task", { task_id: taskId });
    } catch (err) {
      ctx.logger.error("acn-plugin: review(approve) failed", { task_id: taskId, error: String(err) });
    }
  }

  if (status === "cancelled") {
    try {
      await client.reviewTask(taskId, false, "Rejected via Paperclip");
      ctx.logger.info("acn-plugin: rejected task", { task_id: taskId });
    } catch (err) {
      ctx.logger.error("acn-plugin: review(reject) failed", { task_id: taskId, error: String(err) });
    }
  }
}

export async function handleIssueCreated(
  ctx: PluginContext,
  cfg: PluginConfig,
  orgApi: AcnOrgApi,
  event: PluginEvent,
): Promise<void> {
  if (shouldSkipPluginEcho(event, PLUGIN_ID)) return;

  // Paperclip carries entity identity at the event envelope level
  // (`event.entityId` / `event.entityType`); the `payload` only contains
  // change summary fields (title, identifier, status, …) and intentionally
  // omits the description and other long-form content. So we read the id
  // off the envelope and pull the full issue body via `ctx.issues.get`.
  if (event.entityType !== "issue" || !event.entityId) return;
  const issueId = event.entityId;
  const companyId = event.companyId;

  const orgId = (cfg.acnOrgId ?? "").trim();
  if (!orgId) {
    ctx.logger.error("acn-plugin: issue.created skipped — acnOrgId not resolved", {
      issue_id: issueId,
    });
    return;
  }

  // Dedup against both Org work map and legacy Task map (inbound task.* may
  // still create issues during the transition).
  const [workMap, taskMap] = await Promise.all([
    loadMap(ctx, STATE_KEYS.issueWorkMap, companyId),
    loadMap(ctx, STATE_KEYS.issueTaskMap, companyId),
  ]);
  if (reverseLookup(workMap, issueId) || reverseLookup(taskMap, issueId)) return;

  const payload = (event.payload ?? {}) as { title?: string };
  const title = payload.title ?? issueId;

  // Must register before await: ACN delivers org.work_created inline.
  beginOutboundWorkCreate(companyId, issueId, title);
  try {
    const work = await orgApi.createWork(orgId, {
      title,
    });
    const fresh = await loadMap(ctx, STATE_KEYS.issueWorkMap, companyId);
    // Webhook may have already bound work_id → this issue during createWork.
    if (!fresh[work.work_id]) {
      fresh[work.work_id] = issueId;
      await saveMap(ctx, STATE_KEYS.issueWorkMap, companyId, fresh);
    }
    noteRecentOutboundWork(work.work_id);
    ctx.logger.info("acn-plugin: issue.created → Org work created", {
      issue_id: issueId,
      org_id: orgId,
      work_id: work.work_id,
    });
  } catch (err) {
    ctx.logger.error("acn-plugin: failed to create Org work for issue", {
      issue_id: issueId,
      org_id: orgId,
      error: String(err),
    });
  } finally {
    endOutboundWorkCreate(companyId, issueId);
  }
}

// ── Plugin definition ─────────────────────────────────────────────────────────

const plugin = definePlugin({
  async setup(ctx) {
    const cfg = (await ctx.config.get()) as PluginConfig;

    if (!cfg.acnApiKeyRef) {
      ctx.logger.warn("acn-plugin: acnApiKeyRef not configured — skipping setup");
      return;
    }
    if (!(cfg.acnOrgId ?? "").trim() && !(cfg.acnSubnetId ?? "").trim()) {
      ctx.logger.warn(
        "acn-plugin: acnOrgId or acnSubnetId required — skipping setup",
      );
      return;
    }

    const apiKey = await resolveSecretOrLiteral(cfg.acnApiKeyRef, ctx.secrets);
    const client = buildClient(cfg, apiKey);
    const orgApi = new AcnOrgApi(cfg.acnBaseUrl ?? "https://api.acnlabs.dev", apiKey);

    // Resolve the HMAC secret used for X-ACN-Signature verification.
    let harnessSecret: string | null = null;
    if (cfg.acnHarnessSecretRef) {
      try {
        harnessSecret = await resolveSecretOrLiteral(cfg.acnHarnessSecretRef, ctx.secrets);
      } catch (err) {
        ctx.logger.error("acn-plugin: failed to resolve harness secret ref", {
          ref: cfg.acnHarnessSecretRef,
          error: String(err),
        });
      }
    } else {
      ctx.logger.warn(
        "acn-plugin: acnHarnessSecretRef not configured — inbound webhook signatures will NOT be verified (insecure)",
      );
    }

    const companies = await ctx.companies.list();
    if (companies.length > 1) {
      ctx.logger.warn(
        "acn-plugin: multiple Paperclip companies found — only the first is bound to one ACN Org (multi-company mapping is not supported yet)",
        { company_count: companies.length, using: companies[0]?.id },
      );
    }
    const companyId = companies[0]?.id as string | undefined;
    const companyName = (companies[0] as { name?: string } | undefined)?.name;

    try {
      await resolveAcnOrg(ctx, cfg, orgApi, companyId, companyName);
    } catch (err) {
      ctx.logger.error("acn-plugin: failed to resolve/create ACN Org — skipping setup", {
        error: String(err),
      });
      return;
    }

    // Stash for onWebhook()
    _ctx = ctx;
    _cfg = cfg;
    _client = client;
    _harnessSecret = harnessSecret;

    // Legacy task.* echo guard (inbound Task mirror still active).
    try {
      const me = await client.getMyAgent();
      _selfAgentId = me.agent_id;
      ctx.logger.info("acn-plugin: bridge agent identity resolved", {
        agent_id: _selfAgentId,
      });
    } catch (err) {
      ctx.logger.warn("acn-plugin: failed to resolve bridge agent identity (echo guard degraded)", {
        error: String(err),
      });
    }

    // ── P0-1  Register harness webhook ────────────────────────────────────────
    const webhookUrl = harnessWebhookUrl(cfg);
    const subnetId = (cfg.acnSubnetId ?? "").trim();
    if (webhookUrl && subnetId) {
      try {
        await client.registerSubnetHarness(subnetId, webhookUrl, harnessSecret);
        ctx.logger.info("acn-plugin: registered harness", {
          subnet_id: subnetId,
          org_id: cfg.acnOrgId,
          webhook_url: webhookUrl,
          signed: harnessSecret !== null,
        });
      } catch (err) {
        ctx.logger.error("acn-plugin: harness registration failed", { error: String(err) });
      }
    } else if (!webhookUrl) {
      ctx.logger.warn("acn-plugin: paperclipBaseUrl not set — skipping harness registration");
    } else {
      ctx.logger.warn("acn-plugin: no subnet_id after Org resolve — skipping harness registration");
    }

    // ── P0-2  Full initial task sync (legacy inbound) ─────────────────────────
    if (companyId && subnetId) {
      let taskIssueMap = await loadMap(ctx, STATE_KEYS.issueTaskMap, companyId);
      try {
        taskIssueMap = await syncTasks(ctx, client, cfg, companyId, taskIssueMap);
        await saveMap(ctx, STATE_KEYS.issueTaskMap, companyId, taskIssueMap);
      } catch (err) {
        ctx.logger.error("acn-plugin: task full sync failed", { error: String(err) });
      }
    }

    // ── P2c-C3 / legacy: issue status → Org work PATCH or Task review ─────────
    ctx.events.on("issue.updated", async (event) => {
      await handleIssueUpdated(ctx, cfg, client, orgApi, event);
    });

    // ── P2c-C1  Paperclip issue created → Org work ────────────────────────────
    ctx.events.on("issue.created", async (event) => {
      await handleIssueCreated(ctx, cfg, orgApi, event);
    });

    // ── Bridge: getData for ACN tab ────────────────────────────────────────────
    ctx.data.register("acn-task-info", async (params) => {
      const issueId = params.issueId as string | undefined;
      const cid = params.companyId as string | undefined;
      if (!issueId || !cid) return null;

      const workMap = await loadMap(ctx, STATE_KEYS.issueWorkMap, cid);
      const workId = reverseLookup(workMap, issueId);
      if (workId && cfg.acnOrgId) {
        return {
          work_id: workId,
          org_id: cfg.acnOrgId,
          source: "org_work",
          task_id: null,
          title: null,
          status: null,
          reward: null,
          reward_currency: null,
          participations: [],
        };
      }

      const map = await loadMap(ctx, STATE_KEYS.issueTaskMap, cid);
      const taskId = reverseLookup(map, issueId);
      if (!taskId) return null;

      const [task, participations] = await Promise.all([
        client.getTask(taskId),
        client.getTaskParticipations(taskId),
      ]);

      return {
        task_id: task.task_id,
        title: task.title,
        status: task.status,
        reward: task.reward,
        reward_currency: task.reward_currency,
        participations,
        source: "task_pool",
        work_id: null,
        org_id: cfg.acnOrgId ?? null,
      };
    });

    // ── Bridge: performAction for manual review ────────────────────────────────
    ctx.actions.register("acn-review", async (params) => {
      const taskId = params.taskId as string;
      const approved = params.approved as boolean;
      const feedback = params.feedback as string | undefined;
      await client.reviewTask(taskId, approved, feedback);
      return { ok: true };
    });

    ctx.logger.info("acn-plugin: setup complete", {
      org_id: cfg.acnOrgId,
      subnet_id: cfg.acnSubnetId,
    });
  },

  async onHealth() {
    return { status: "ok", message: "ACN plugin running" };
  },

  // ── P0-3  Inbound ACN webhook events ──────────────────────────────────────────
  async onWebhook(input) {
    if (input.endpointKey !== WEBHOOK_KEYS.acnEvents) return;
    if (!_ctx || !_cfg || !_client) {
      // setup() hasn't completed yet — rare, but guard it
      return;
    }
    if (!verifyAcnSignature(input.headers, input.rawBody, _harnessSecret)) {
      _ctx.logger.warn("acn-plugin: rejected webhook with invalid signature", {
        request_id: input.requestId,
      });
      return;
    }
    await handleAcnWebhook(_ctx, _cfg, _client, input.rawBody);
  },
});

// ── Entry point ───────────────────────────────────────────────────────────────

export default plugin;
runWorker(plugin, import.meta.url);
