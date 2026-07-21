/**
 * ACN Plugin Worker
 *
 * Responsibilities:
 *  P0-1  Startup  : resolve/create ACN Org; register subnet harness webhook
 *  P0-2  Startup  : full sync — pull open ACN tasks → Paperclip issues (legacy)
 *  P0-3  ACN→PC   : task.* webhook events → sync Paperclip issue status / comments (legacy)
 *  P0-4  PC→ACN   : Paperclip issue done/cancelled → ACN task review (legacy)
 *  P2c-C1 PC→ACN  : Paperclip issue created → Org work (NOT Task Pool)
 */

import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { ACNClient, type Task } from "acn-client";
import { PLUGIN_ID, STATE_KEYS, WEBHOOK_KEYS } from "./constants.js";
import { AcnHttpError, AcnOrgApi, orgSubnetId } from "./lib/org-api.js";
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
 * `data` fields vary per event — task events use one shape,
 * participation events use another.
 */
interface AcnTaskEventPayload {
  event: string;
  timestamp?: string;
  task_id: string;
  /** Task-level event data (task.created / task.accepted / task.submitted / ...) */
  data: {
    status?: string;
    creator_id?: string;
    /** Assigned agent ID — present on task.accepted */
    assignee_id?: string;
    reward?: string;
    reward_currency?: string;
    subnet_id?: string;
    max_participants?: number;
    // Participation-level event data (participation.rejected)
    participation_id?: string;
    /** ACN agent ID of the participant */
    participant_id?: string;
    participant_name?: string;
    participation_status?: string;
    resubmit_count?: number;
    max_resubmit_attempts?: number;
    rejection_reason?: string;
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
 * created (legacy Task path). Org work create does not emit task.created.
 */
let _selfAgentId: string | null = null;

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
    if (err instanceof AcnHttpError && err.status === 409) {
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
    if (task.subnet_id !== cfg.acnSubnetId) continue;
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

// ── ACN webhook event handler ─────────────────────────────────────────────────

async function handleAcnWebhook(
  ctx: PluginContext,
  cfg: PluginConfig,
  client: ACNClient,
  rawBody: string,
): Promise<void> {
  let payload: AcnTaskEventPayload;
  try {
    payload = JSON.parse(rawBody) as AcnTaskEventPayload;
  } catch {
    ctx.logger.warn("acn-plugin: received unparseable webhook body");
    return;
  }
  if (!payload.event) return;

  ctx.logger.info("acn-plugin: received ACN event", { event: payload.event });

  const companies = await ctx.companies.list();
  const companyId = companies[0]?.id;
  if (!companyId) return;

  const taskIssueMap = await loadMap(ctx, STATE_KEYS.issueTaskMap, companyId);
  const { task_id, data } = payload;

  switch (payload.event) {
    case "task.created": {
      if (!cfg.autoCreateIssues) break;
      if (taskIssueMap[task_id]) break;
      // Echo guard: skip tasks the bridge agent itself created. The plugin's
      // `handleIssueCreated` path also calls ACN createTask synchronously,
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

  const companyId = event.companyId;
  const taskIssueMap = await loadMap(ctx, STATE_KEYS.issueTaskMap, companyId);
  const taskId = reverseLookup(taskIssueMap, issueId);
  if (!taskId) return;

  if (status !== "done" && status !== "cancelled") return;

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

  try {
    const work = await orgApi.createWork(orgId, {
      title: payload.title ?? issueId,
    });
    const fresh = await loadMap(ctx, STATE_KEYS.issueWorkMap, companyId);
    fresh[work.work_id] = issueId;
    await saveMap(ctx, STATE_KEYS.issueWorkMap, companyId, fresh);
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

    // ── P0-4  Paperclip issue status → ACN review (legacy Task) ───────────────
    ctx.events.on("issue.updated", async (event) => {
      await handleIssueUpdated(ctx, cfg, client, event);
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
