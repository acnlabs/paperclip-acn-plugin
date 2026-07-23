/**
 * Regression tests for the Paperclip-event → ACN handlers in worker.ts.
 *
 * P2c C1: issue.created creates Org work (not Task Pool createTask).
 * P2c C3: issue.updated on Org-mapped issues PATCHes work status.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type { ACNClient } from "acn-client";
import { STATE_KEYS } from "../src/constants.ts";
import type { AcnOrgApi } from "../src/lib/org-api.ts";
import { handleIssueCreated, handleIssueUpdated } from "../src/worker.ts";

// ── Mock factories ────────────────────────────────────────────────────────────

interface Spy<Args extends unknown[], Ret> {
  (...args: Args): Ret;
  calls: Args[];
}

function spy<Args extends unknown[], Ret>(impl: (...args: Args) => Ret): Spy<Args, Ret> {
  const fn = ((...args: Args) => {
    fn.calls.push(args);
    return impl(...args);
  }) as Spy<Args, Ret>;
  fn.calls = [];
  return fn;
}

interface MockCtxOverrides {
  /** Legacy alias for taskMap (task_id → issue_id). */
  stateMap?: Record<string, string>;
  taskMap?: Record<string, string>;
  workMap?: Record<string, string>;
  issueBody?: { description?: string };
  companyId?: string;
}

function makeCtx(overrides: MockCtxOverrides = {}) {
  const companyId = overrides.companyId ?? "co-1";
  const store: Record<string, string> = {
    [STATE_KEYS.issueTaskMap]: JSON.stringify(
      overrides.taskMap ?? overrides.stateMap ?? {},
    ),
    [STATE_KEYS.issueWorkMap]: JSON.stringify(overrides.workMap ?? {}),
  };
  const issueBody = overrides.issueBody ?? null;
  const logger = {
    info: spy(() => {}),
    warn: spy(() => {}),
    error: spy(() => {}),
    debug: spy(() => {}),
  };
  const ctx = {
    logger,
    state: {
      get: spy(async (q: { stateKey: string }) => store[q.stateKey] ?? null),
      set: spy(async (q: { stateKey: string }, value: string) => {
        store[q.stateKey] = value;
      }),
    },
    issues: {
      get: spy(async (_id: string, _cid: string) => issueBody),
      create: spy(async () => ({ id: "iss-fresh" })),
      update: spy(async () => {}),
      createComment: spy(async () => {}),
    },
    companies: {
      list: spy(async () => [{ id: companyId }]),
    },
  };
  return ctx as unknown as PluginContext & typeof ctx;
}

function makeOrgApi(
  opts: {
    createWorkReturn?: { work_id: string };
    updateShouldThrow?: boolean;
  } = {},
) {
  const createWork = spy(async () => opts.createWorkReturn ?? { work_id: "work-new" });
  const updateWorkStatus = spy(async () => {
    if (opts.updateShouldThrow) throw new Error("patch boom");
    return { work_id: "work-1", status: "done" };
  });
  return { createWork, updateWorkStatus } as unknown as AcnOrgApi & {
    createWork: typeof createWork;
    updateWorkStatus: typeof updateWorkStatus;
  };
}

function makeClient(opts: {
  getTaskStatus?: string;
  reviewShouldThrow?: boolean;
} = {}) {
  const getTask = spy(async () => ({ status: opts.getTaskStatus ?? "submitted" }));
  const reviewTask = spy(async () => {
    if (opts.reviewShouldThrow) throw new Error("review boom");
    return {};
  });
  const createTask = spy(async () => {
    throw new Error("createTask must not be called after P2c C1");
  });
  return { createTask, getTask, reviewTask } as unknown as ACNClient & {
    createTask: typeof createTask;
    getTask: typeof getTask;
    reviewTask: typeof reviewTask;
  };
}

const baseCfg = {
  acnBaseUrl: "http://acn.local",
  paperclipBaseUrl: "http://pc.local",
  acnOrgId: "org_test",
  acnSubnetId: "sub-1",
  autoCreateIssues: true,
  enableLegacyTaskMirror: false,
  autoApproveOnDone: true,
};

// ── handleIssueCreated ────────────────────────────────────────────────────────

describe("handleIssueCreated", () => {
  function createdEvent(opts: {
    entityId?: string;
    title?: string;
    actorType?: string;
    entityType?: string;
  } = {}): PluginEvent {
    return {
      entityType: opts.entityType ?? "issue",
      entityId: opts.entityId ?? "iss-1",
      companyId: "co-1",
      actorType: opts.actorType ?? "user",
      payload: opts.title !== undefined ? { title: opts.title } : { title: "Hello" },
    } as unknown as PluginEvent;
  }

  it("reads issueId from event.entityId and creates Org work (not Task)", async () => {
    const ctx = makeCtx();
    const orgApi = makeOrgApi({ createWorkReturn: { work_id: "work-42" } });
    await handleIssueCreated(ctx, baseCfg, orgApi, createdEvent({ title: "Ship" }));
    assert.equal(orgApi.createWork.calls.length, 1);
    assert.deepEqual(orgApi.createWork.calls[0]!.slice(0, 2), [
      "org_test",
      { title: "Ship" },
    ]);
  });

  it("uses entityId as title when payload.title is missing", async () => {
    const ctx = makeCtx();
    const orgApi = makeOrgApi();
    const event = {
      entityType: "issue",
      entityId: "iss-no-title",
      companyId: "co-1",
      actorType: "user",
      payload: {},
    } as unknown as PluginEvent;
    await handleIssueCreated(ctx, baseCfg, orgApi, event);
    assert.equal(orgApi.createWork.calls[0]![1].title, "iss-no-title");
  });

  it("is a no-op when the echo guard fires (actorType=plugin)", async () => {
    const ctx = makeCtx();
    const orgApi = makeOrgApi();
    await handleIssueCreated(
      ctx,
      baseCfg,
      orgApi,
      createdEvent({ actorType: "plugin" }),
    );
    assert.equal(orgApi.createWork.calls.length, 0);
  });

  it("skips when entityType is not 'issue'", async () => {
    const ctx = makeCtx();
    const orgApi = makeOrgApi();
    await handleIssueCreated(
      ctx,
      baseCfg,
      orgApi,
      createdEvent({ entityType: "agent" }),
    );
    assert.equal(orgApi.createWork.calls.length, 0);
  });

  it("skips when entityId is missing", async () => {
    const ctx = makeCtx();
    const orgApi = makeOrgApi();
    const event = {
      entityType: "issue",
      companyId: "co-1",
      actorType: "user",
      payload: { title: "x" },
    } as unknown as PluginEvent;
    await handleIssueCreated(ctx, baseCfg, orgApi, event);
    assert.equal(orgApi.createWork.calls.length, 0);
  });

  it("skips when acnOrgId is missing", async () => {
    const ctx = makeCtx();
    const orgApi = makeOrgApi();
    await handleIssueCreated(
      ctx,
      { ...baseCfg, acnOrgId: "" },
      orgApi,
      createdEvent(),
    );
    assert.equal(orgApi.createWork.calls.length, 0);
  });

  it("does NOT createWork when the issue is already round-tripped (legacy task map)", async () => {
    const ctx = makeCtx({ taskMap: { "task-1": "iss-1" } });
    const orgApi = makeOrgApi();
    await handleIssueCreated(ctx, baseCfg, orgApi, createdEvent({ entityId: "iss-1" }));
    assert.equal(orgApi.createWork.calls.length, 0);
  });

  it("does NOT createWork when the issue is already mapped to Org work", async () => {
    const ctx = makeCtx({ workMap: { "work-1": "iss-1" } });
    const orgApi = makeOrgApi();
    await handleIssueCreated(ctx, baseCfg, orgApi, createdEvent({ entityId: "iss-1" }));
    assert.equal(orgApi.createWork.calls.length, 0);
  });
});

// ── handleIssueUpdated ────────────────────────────────────────────────────────

describe("handleIssueUpdated", () => {
  function eventWithStatus(status: string, opts: { entityId?: string } = {}): PluginEvent {
    return {
      entityType: "issue",
      entityId: opts.entityId ?? "iss-10",
      companyId: "co-1",
      actorType: "user",
      payload: { status },
    } as unknown as PluginEvent;
  }

  it("PATCHes Org work when issue is mapped via issue-work-map (done)", async () => {
    const ctx = makeCtx({ workMap: { "work-1": "iss-10" } });
    const client = makeClient();
    const orgApi = makeOrgApi();
    await handleIssueUpdated(ctx, baseCfg, client, orgApi, eventWithStatus("done"));
    assert.equal(orgApi.updateWorkStatus.calls.length, 1);
    assert.deepEqual(orgApi.updateWorkStatus.calls[0], [
      "org_test",
      "work-1",
      { status: "done" },
    ]);
    assert.equal(client.reviewTask.calls.length, 0);
  });

  it("PATCHes Org work cancelled without requiring autoApproveOnDone", async () => {
    const ctx = makeCtx({ workMap: { "work-1": "iss-10" } });
    const client = makeClient();
    const orgApi = makeOrgApi();
    await handleIssueUpdated(
      ctx,
      { ...baseCfg, autoApproveOnDone: false },
      client,
      orgApi,
      eventWithStatus("cancelled"),
    );
    assert.equal(orgApi.updateWorkStatus.calls.length, 1);
    assert.deepEqual(orgApi.updateWorkStatus.calls[0]![2], { status: "cancelled" });
  });

  it("skips Org work done when autoApproveOnDone is false", async () => {
    const ctx = makeCtx({ workMap: { "work-1": "iss-10" } });
    const client = makeClient();
    const orgApi = makeOrgApi();
    await handleIssueUpdated(
      ctx,
      { ...baseCfg, autoApproveOnDone: false },
      client,
      orgApi,
      eventWithStatus("done"),
    );
    assert.equal(orgApi.updateWorkStatus.calls.length, 0);
    assert.equal(client.reviewTask.calls.length, 0);
  });

  it("swallows Org PATCH errors without throwing", async () => {
    const ctx = makeCtx({ workMap: { "work-1": "iss-10" } });
    const client = makeClient();
    const orgApi = makeOrgApi({ updateShouldThrow: true });
    await handleIssueUpdated(ctx, baseCfg, client, orgApi, eventWithStatus("done"));
    assert.equal(orgApi.updateWorkStatus.calls.length, 1);
  });

  it("prefers Org work path over legacy Task when both maps exist", async () => {
    const ctx = makeCtx({
      workMap: { "work-1": "iss-10" },
      taskMap: { "task-1": "iss-10" },
    });
    const client = makeClient({ getTaskStatus: "submitted" });
    const orgApi = makeOrgApi();
    await handleIssueUpdated(ctx, baseCfg, client, orgApi, eventWithStatus("done"));
    assert.equal(orgApi.updateWorkStatus.calls.length, 1);
    assert.equal(client.reviewTask.calls.length, 0);
  });

  it("approves the ACN task when status flips to 'done' and autoApproveOnDone=true", async () => {
    const ctx = makeCtx({ taskMap: { "task-1": "iss-10" } });
    const client = makeClient({ getTaskStatus: "submitted" });
    const orgApi = makeOrgApi();
    await handleIssueUpdated(ctx, baseCfg, client, orgApi, eventWithStatus("done"));
    assert.equal(client.reviewTask.calls.length, 1);
    assert.equal(orgApi.updateWorkStatus.calls.length, 0);
  });

  it("rejects the ACN task when status flips to 'cancelled'", async () => {
    const ctx = makeCtx({ taskMap: { "task-1": "iss-10" } });
    const client = makeClient({ getTaskStatus: "submitted" });
    const orgApi = makeOrgApi();
    await handleIssueUpdated(ctx, baseCfg, client, orgApi, eventWithStatus("cancelled"));
    assert.equal(client.reviewTask.calls.length, 1);
  });

  it("is a no-op when neither work nor task is mapped", async () => {
    const ctx = makeCtx();
    const client = makeClient();
    const orgApi = makeOrgApi();
    await handleIssueUpdated(ctx, baseCfg, client, orgApi, eventWithStatus("done"));
    assert.equal(client.getTask.calls.length, 0);
    assert.equal(client.reviewTask.calls.length, 0);
    assert.equal(orgApi.updateWorkStatus.calls.length, 0);
  });

  it("skips review when autoApproveOnDone is false and status is done (legacy)", async () => {
    const ctx = makeCtx({ taskMap: { "task-1": "iss-10" } });
    const client = makeClient({ getTaskStatus: "submitted" });
    const orgApi = makeOrgApi();
    await handleIssueUpdated(
      ctx,
      { ...baseCfg, autoApproveOnDone: false },
      client,
      orgApi,
      eventWithStatus("done"),
    );
    assert.equal(client.reviewTask.calls.length, 0);
  });

  it("skips when task is not in submitted status", async () => {
    const ctx = makeCtx({ taskMap: { "task-1": "iss-10" } });
    const client = makeClient({ getTaskStatus: "in_progress" });
    const orgApi = makeOrgApi();
    await handleIssueUpdated(ctx, baseCfg, client, orgApi, eventWithStatus("done"));
    assert.equal(client.reviewTask.calls.length, 0);
  });

  it("swallows review errors without throwing", async () => {
    const ctx = makeCtx({ taskMap: { "task-1": "iss-10" } });
    const client = makeClient({ getTaskStatus: "submitted", reviewShouldThrow: true });
    const orgApi = makeOrgApi();
    await handleIssueUpdated(ctx, baseCfg, client, orgApi, eventWithStatus("done"));
    assert.equal(client.reviewTask.calls.length, 1);
  });
});
