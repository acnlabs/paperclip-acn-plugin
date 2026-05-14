/**
 * Regression tests for the Paperclip-event → ACN handlers in worker.ts.
 *
 * Two real production bugs surfaced during the local E2E smoke and motivated
 * these tests:
 *
 *   1. `handleIssueCreated` originally read `payload.issueId` and
 *      `payload.description`. Paperclip's `issue.created` envelope actually
 *      carries the id at `event.entityId` and intentionally omits the body —
 *      the worker has to fetch the full issue via `ctx.issues.get`. The old
 *      code silently created ACN tasks with the title as the body, or 500'd
 *      on undefined id.
 *
 *   2. `handleIssueUpdated` originally read `payload.changes.status`.
 *      Paperclip emits a flat payload with `status` at the top level (no
 *      `changes` envelope). The old code never observed any status change
 *      and the PC→ACN review path was effectively dead.
 *
 * These tests pin the contract so future schema drifts in either codebase
 * are caught immediately.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type { ACNClient } from "acn-client";
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

function makeClient(opts: {
  createTaskReturn?: { task_id: string };
  getTaskStatus?: string;
  reviewShouldThrow?: boolean;
} = {}) {
  const createTask = spy(async () => opts.createTaskReturn ?? { task_id: "task-new" });
  const getTask = spy(async () => ({ status: opts.getTaskStatus ?? "submitted" }));
  const reviewTask = spy(async () => {
    if (opts.reviewShouldThrow) throw new Error("review boom");
    return {};
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
  acnSubnetId: "sub-1",
  autoCreateIssues: true,
  autoApproveOnDone: true,
};

// ── handleIssueCreated ────────────────────────────────────────────────────────

describe("handleIssueCreated", () => {
  it("reads issueId from event.entityId (NOT payload.issueId) and fetches description via ctx.issues.get", async () => {
    const ctx = makeCtx({
      issueBody: { description: "Full body from issues.get" },
    });
    const client = makeClient({ createTaskReturn: { task_id: "task-abc" } });

    const event: PluginEvent = {
      kind: "issue.created" as PluginEvent["kind"],
      entityType: "issue",
      entityId: "iss-42",
      companyId: "co-1",
      actorType: "user",
      payload: { title: "Title-from-payload" },
    } as unknown as PluginEvent;

    await handleIssueCreated(ctx, baseCfg, client, event);

    assert.equal(client.createTask.calls.length, 1, "createTask called exactly once");
    const [createReq] = client.createTask.calls[0] as [Record<string, unknown>];
    assert.equal(createReq.title, "Title-from-payload");
    assert.equal(
      createReq.description,
      "Full body from issues.get",
      "description must come from ctx.issues.get, not from event.payload",
    );

    // issues.get was called with the entityId, NOT some payload.issueId field
    assert.equal(ctx.issues.get.calls.length, 1);
    const [fetchedId] = ctx.issues.get.calls[0];
    assert.equal(fetchedId, "iss-42");

    // saveMap must have run with task_id → entityId mapping
    assert.equal(ctx.state.set.calls.length, 1);
    const [, payloadJson] = ctx.state.set.calls[0] as [unknown, string];
    const persisted = JSON.parse(payloadJson) as Record<string, string>;
    assert.equal(persisted["task-abc"], "iss-42");
  });

  it("falls back to a default description when ctx.issues.get yields no body", async () => {
    const ctx = makeCtx({ issueBody: null });
    const client = makeClient();
    const event = {
      entityType: "issue",
      entityId: "iss-1",
      companyId: "co-1",
      actorType: "user",
      payload: { title: "T" },
    } as unknown as PluginEvent;

    await handleIssueCreated(ctx, baseCfg, client, event);

    const [createReq] = client.createTask.calls[0] as [Record<string, unknown>];
    assert.equal(createReq.description, "Task created from Paperclip issue.");
  });

  it("is a no-op when the echo guard fires (actorType=plugin)", async () => {
    const ctx = makeCtx();
    const client = makeClient();
    const event = {
      entityType: "issue",
      entityId: "iss-1",
      companyId: "co-1",
      actorType: "plugin",
      payload: {},
    } as unknown as PluginEvent;

    await handleIssueCreated(ctx, baseCfg, client, event);

    assert.equal(client.createTask.calls.length, 0);
    assert.equal(ctx.issues.get.calls.length, 0);
  });

  it("skips when entityType is not 'issue'", async () => {
    const ctx = makeCtx();
    const client = makeClient();
    const event = {
      entityType: "comment",
      entityId: "cmt-1",
      companyId: "co-1",
      actorType: "user",
      payload: {},
    } as unknown as PluginEvent;

    await handleIssueCreated(ctx, baseCfg, client, event);

    assert.equal(client.createTask.calls.length, 0);
  });

  it("skips when entityId is missing", async () => {
    const ctx = makeCtx();
    const client = makeClient();
    const event = {
      entityType: "issue",
      entityId: undefined,
      companyId: "co-1",
      actorType: "user",
      payload: {},
    } as unknown as PluginEvent;

    await handleIssueCreated(ctx, baseCfg, client, event);

    assert.equal(client.createTask.calls.length, 0);
  });

  it("does NOT createTask when the issue is already round-tripped (reverseLookup hit)", async () => {
    // task-existing → iss-9 is already in state. issue.created for iss-9
    // is therefore an echo of an ACN-mirrored issue and must NOT recreate.
    const ctx = makeCtx({ stateMap: { "task-existing": "iss-9" } });
    const client = makeClient();
    const event = {
      entityType: "issue",
      entityId: "iss-9",
      companyId: "co-1",
      actorType: "user",
      payload: { title: "echo" },
    } as unknown as PluginEvent;

    await handleIssueCreated(ctx, baseCfg, client, event);

    assert.equal(client.createTask.calls.length, 0);
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
    const ctx = makeCtx({ stateMap: { "task-7": "iss-10" } });
    const client = makeClient({ getTaskStatus: "submitted" });

    await handleIssueUpdated(ctx, baseCfg, client, eventWithStatus("done"));

    assert.equal(client.reviewTask.calls.length, 1);
    const [taskId, approved, notes] = client.reviewTask.calls[0] as [string, boolean, string];
    assert.equal(taskId, "task-7");
    assert.equal(approved, true);
    assert.match(notes, /Approved/);
  });

  it("rejects the ACN task when status flips to 'cancelled'", async () => {
    const ctx = makeCtx({ stateMap: { "task-7": "iss-10" } });
    const client = makeClient({ getTaskStatus: "submitted" });

    await handleIssueUpdated(ctx, baseCfg, client, eventWithStatus("cancelled"));

    assert.equal(client.reviewTask.calls.length, 1);
    const [taskId, approved] = client.reviewTask.calls[0] as [string, boolean];
    assert.equal(taskId, "task-7");
    assert.equal(approved, false);
  });

  it("does NOT touch ACN when status is missing from the payload (NOT a status-changing update)", async () => {
    const ctx = makeCtx({ stateMap: { "task-7": "iss-10" } });
    const client = makeClient();
    const event = {
      entityType: "issue",
      entityId: "iss-10",
      companyId: "co-1",
      actorType: "user",
      payload: { title: "renamed" },
    } as unknown as PluginEvent;

    await handleIssueUpdated(ctx, baseCfg, client, event);

    assert.equal(client.reviewTask.calls.length, 0);
    assert.equal(client.getTask.calls.length, 0);
  });

  it("does NOT review when the ACN task is not in 'submitted' state (e.g. still in_progress)", async () => {
    const ctx = makeCtx({ stateMap: { "task-7": "iss-10" } });
    const client = makeClient({ getTaskStatus: "in_progress" });

    await handleIssueUpdated(ctx, baseCfg, client, eventWithStatus("done"));

    assert.equal(client.reviewTask.calls.length, 0);
  });

  it("does NOT approve when autoApproveOnDone=false (manual review pending)", async () => {
    const ctx = makeCtx({ stateMap: { "task-7": "iss-10" } });
    const client = makeClient({ getTaskStatus: "submitted" });

    await handleIssueUpdated(
      ctx,
      { ...baseCfg, autoApproveOnDone: false },
      client,
      eventWithStatus("done"),
    );

    assert.equal(client.reviewTask.calls.length, 0);
  });

  it("is a no-op when no taskId is mapped for the issue (PC-only issue)", async () => {
    const ctx = makeCtx({ stateMap: {} });
    const client = makeClient();

    await handleIssueUpdated(ctx, baseCfg, client, eventWithStatus("done"));

    assert.equal(client.getTask.calls.length, 0);
    assert.equal(client.reviewTask.calls.length, 0);
  });

  it("is a no-op when the echo guard fires (actorType=plugin)", async () => {
    const ctx = makeCtx({ stateMap: { "task-7": "iss-10" } });
    const client = makeClient();
    const event = {
      entityType: "issue",
      entityId: "iss-10",
      companyId: "co-1",
      actorType: "plugin",
      payload: { status: "done" },
    } as unknown as PluginEvent;

    await handleIssueUpdated(ctx, baseCfg, client, event);

    assert.equal(client.reviewTask.calls.length, 0);
    assert.equal(ctx.state.get.calls.length, 0);
  });

  it("does NOT misread a legacy payload.changes.status shape as a status update", async () => {
    // Regression: the old impl read `payload.changes.status`. If a backend
    // ever regresses to that shape, we want this test to fail loudly rather
    // than silently approve every issue update.
    const ctx = makeCtx({ stateMap: { "task-7": "iss-10" } });
    const client = makeClient({ getTaskStatus: "submitted" });
    const event = {
      entityType: "issue",
      entityId: "iss-10",
      companyId: "co-1",
      actorType: "user",
      payload: { changes: { status: "done" } },
    } as unknown as PluginEvent;

    await handleIssueUpdated(ctx, baseCfg, client, event);

    assert.equal(
      client.reviewTask.calls.length,
      0,
      "must not interpret nested changes.status as a real status change",
    );
  });
});
