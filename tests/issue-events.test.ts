/**
 * Regression tests for the Paperclip-event → ACN handlers in worker.ts.
 *
 * P2c C1: issue.created creates Org work (not Task Pool createTask).
 * handleIssueUpdated still drives legacy Task review until C3.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type { ACNClient } from "acn-client";
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
  stateMap?: Record<string, string>;
  issueBody?: { description?: string };
  companyId?: string;
}

function makeCtx(overrides: MockCtxOverrides = {}) {
  const stateMap = overrides.stateMap ?? {};
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
      get: spy(async () => JSON.stringify(stateMap)),
      set: spy(async () => {}),
    },
    issues: {
      get: spy(async (_id: string, _cid: string) => issueBody),
      create: spy(async () => ({ id: "iss-fresh" })),
      update: spy(async () => {}),
      createComment: spy(async () => {}),
    },
    companies: {
      list: spy(async () => [{ id: overrides.companyId ?? "co-1" }]),
    },
  };
  return ctx as unknown as PluginContext & typeof ctx;
}

function makeOrgApi(opts: { createWorkReturn?: { work_id: string } } = {}) {
  const createWork = spy(async () => opts.createWorkReturn ?? { work_id: "work-new" });
  return { createWork } as unknown as AcnOrgApi & { createWork: typeof createWork };
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
  autoApproveOnDone: true,
};

// ── handleIssueCreated ────────────────────────────────────────────────────────

describe("handleIssueCreated", () => {
  it("reads issueId from event.entityId and creates Org work (not Task)", async () => {
    const ctx = makeCtx({
      issueBody: { description: "Full body from issues.get" },
    });
    const orgApi = makeOrgApi({ createWorkReturn: { work_id: "work-abc" } });

    const event: PluginEvent = {
      kind: "issue.created" as PluginEvent["kind"],
      entityType: "issue",
      entityId: "iss-42",
      companyId: "co-1",
      actorType: "user",
      payload: { title: "Title-from-payload" },
    } as unknown as PluginEvent;

    await handleIssueCreated(ctx, baseCfg, orgApi, event);

    assert.equal(orgApi.createWork.calls.length, 1, "createWork called exactly once");
    const [orgId, createReq] = orgApi.createWork.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    assert.equal(orgId, "org_test");
    assert.equal(createReq.title, "Title-from-payload");
    assert.equal(ctx.issues.get.calls.length, 0, "C1 does not fetch issue body");

    assert.equal(ctx.state.set.calls.length, 1);
    const [, payloadJson] = ctx.state.set.calls[0] as [unknown, string];
    const persisted = JSON.parse(payloadJson) as Record<string, string>;
    assert.equal(persisted["work-abc"], "iss-42");
  });

  it("uses entityId as title when payload.title is missing", async () => {
    const ctx = makeCtx();
    const orgApi = makeOrgApi();
    const event = {
      entityType: "issue",
      entityId: "iss-1",
      companyId: "co-1",
      actorType: "user",
      payload: {},
    } as unknown as PluginEvent;

    await handleIssueCreated(ctx, baseCfg, orgApi, event);

    assert.equal(orgApi.createWork.calls.length, 1);
    const [, createReq] = orgApi.createWork.calls[0] as [string, Record<string, unknown>];
    assert.equal(createReq.title, "iss-1");
  });

  it("is a no-op when the echo guard fires (actorType=plugin)", async () => {
    const ctx = makeCtx();
    const orgApi = makeOrgApi();
    const event = {
      entityType: "issue",
      entityId: "iss-1",
      companyId: "co-1",
      actorType: "plugin",
      payload: {},
    } as unknown as PluginEvent;

    await handleIssueCreated(ctx, baseCfg, orgApi, event);

    assert.equal(orgApi.createWork.calls.length, 0);
    assert.equal(ctx.issues.get.calls.length, 0);
  });

  it("skips when entityType is not 'issue'", async () => {
    const ctx = makeCtx();
    const orgApi = makeOrgApi();
    const event = {
      entityType: "comment",
      entityId: "cmt-1",
      companyId: "co-1",
      actorType: "user",
      payload: {},
    } as unknown as PluginEvent;

    await handleIssueCreated(ctx, baseCfg, orgApi, event);

    assert.equal(orgApi.createWork.calls.length, 0);
  });

  it("skips when entityId is missing", async () => {
    const ctx = makeCtx();
    const orgApi = makeOrgApi();
    const event = {
      entityType: "issue",
      entityId: undefined,
      companyId: "co-1",
      actorType: "user",
      payload: {},
    } as unknown as PluginEvent;

    await handleIssueCreated(ctx, baseCfg, orgApi, event);

    assert.equal(orgApi.createWork.calls.length, 0);
  });

  it("skips when acnOrgId is missing", async () => {
    const ctx = makeCtx();
    const orgApi = makeOrgApi();
    const event = {
      entityType: "issue",
      entityId: "iss-1",
      companyId: "co-1",
      actorType: "user",
      payload: { title: "x" },
    } as unknown as PluginEvent;

    await handleIssueCreated(ctx, { ...baseCfg, acnOrgId: "" }, orgApi, event);

    assert.equal(orgApi.createWork.calls.length, 0);
  });

  it("does NOT createWork when the issue is already round-tripped (legacy task map)", async () => {
    const ctx = makeCtx({ stateMap: { "task-existing": "iss-9" } });
    const orgApi = makeOrgApi();
    const event = {
      entityType: "issue",
      entityId: "iss-9",
      companyId: "co-1",
      actorType: "user",
      payload: { title: "echo" },
    } as unknown as PluginEvent;

    await handleIssueCreated(ctx, baseCfg, orgApi, event);

    assert.equal(orgApi.createWork.calls.length, 0);
  });

  it("does NOT createWork when the issue is already mapped to Org work", async () => {
    const ctx = makeCtx({ stateMap: { "work-existing": "iss-9" } });
    const orgApi = makeOrgApi();
    const event = {
      entityType: "issue",
      entityId: "iss-9",
      companyId: "co-1",
      actorType: "user",
      payload: { title: "echo" },
    } as unknown as PluginEvent;

    await handleIssueCreated(ctx, baseCfg, orgApi, event);

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
      payload: { status }, // flat — NOT payload.changes.status
    } as unknown as PluginEvent;
  }

  it("approves the ACN task when status flips to 'done' and autoApproveOnDone=true", async () => {
    const ctx = makeCtx({ stateMap: { "task-1": "iss-10" } });
    const client = makeClient({ getTaskStatus: "submitted" });
    await handleIssueUpdated(ctx, baseCfg, client, eventWithStatus("done"));
    assert.equal(client.reviewTask.calls.length, 1);
  });

  it("rejects the ACN task when status flips to 'cancelled'", async () => {
    const ctx = makeCtx({ stateMap: { "task-1": "iss-10" } });
    const client = makeClient({ getTaskStatus: "submitted" });
    await handleIssueUpdated(ctx, baseCfg, client, eventWithStatus("cancelled"));
    assert.equal(client.reviewTask.calls.length, 1);
  });

  it("is a no-op when there is no mapped Task (Org-work-only issues until C3)", async () => {
    // C1 stores work_id→issue in issue-work-map; handleIssueUpdated still
    // only reads the legacy task map, so Org-backed issues correctly skip review.
    const ctx = makeCtx({ stateMap: {} });
    const client = makeClient();
    await handleIssueUpdated(ctx, baseCfg, client, eventWithStatus("done"));
    assert.equal(client.getTask.calls.length, 0);
    assert.equal(client.reviewTask.calls.length, 0);
  });

  it("skips review when autoApproveOnDone is false and status is done", async () => {
    const ctx = makeCtx({ stateMap: { "task-1": "iss-10" } });
    const client = makeClient({ getTaskStatus: "submitted" });
    await handleIssueUpdated(
      ctx,
      { ...baseCfg, autoApproveOnDone: false },
      client,
      eventWithStatus("done"),
    );
    assert.equal(client.reviewTask.calls.length, 0);
  });

  it("skips when task is not in submitted status", async () => {
    const ctx = makeCtx({ stateMap: { "task-1": "iss-10" } });
    const client = makeClient({ getTaskStatus: "in_progress" });
    await handleIssueUpdated(ctx, baseCfg, client, eventWithStatus("done"));
    assert.equal(client.reviewTask.calls.length, 0);
  });

  it("swallows review errors without throwing", async () => {
    const ctx = makeCtx({ stateMap: { "task-1": "iss-10" } });
    const client = makeClient({ getTaskStatus: "submitted", reviewShouldThrow: true });
    await handleIssueUpdated(ctx, baseCfg, client, eventWithStatus("done"));
    assert.equal(client.reviewTask.calls.length, 1);
  });
});
