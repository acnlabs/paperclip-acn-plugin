/**
 * P2c C2: inbound org.work_* / org.loop_tick → Paperclip Issues.
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { STATE_KEYS } from "../src/constants.ts";
import {
  beginOutboundWorkCreate,
  clearRecentOutboundWorkForTests,
  endOutboundWorkCreate,
  handleOrgLoopTick,
  handleOrgWorkCreated,
  handleOrgWorkUpdated,
  noteRecentOutboundWork,
  type PluginConfig,
} from "../src/worker.ts";

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

function makeCtx(opts: {
  workMap?: Record<string, string>;
  companyId?: string;
} = {}) {
  const companyId = opts.companyId ?? "co-1";
  const store: Record<string, string> = {
    [STATE_KEYS.issueWorkMap]: JSON.stringify(opts.workMap ?? {}),
  };
  const logger = {
    info: spy(() => {}),
    warn: spy(() => {}),
    error: spy(() => {}),
    debug: spy(() => {}),
  };
  const issues = {
    create: spy(async () => ({ id: "iss-from-work" })),
    update: spy(async () => {}),
    createComment: spy(async () => {}),
  };
  const ctx = {
    logger,
    state: {
      get: spy(async (q: { stateKey: string }) => store[q.stateKey] ?? null),
      set: spy(async (q: { stateKey: string }, value: string) => {
        store[q.stateKey] = value;
      }),
    },
    issues,
    companies: {
      list: spy(async () => [{ id: companyId }]),
    },
  };
  return {
    ctx: ctx as unknown as PluginContext & typeof ctx,
    store,
    issues,
    companyId,
  };
}

const baseCfg: PluginConfig = {
  acnBaseUrl: "http://acn.local",
  paperclipBaseUrl: "http://pc.local",
  acnOrgId: "org_test",
  acnSubnetId: "sub-1",
  autoCreateIssues: true,
  autoApproveOnDone: true,
};

afterEach(() => {
  clearRecentOutboundWorkForTests();
});

describe("handleOrgWorkCreated", () => {
  it("creates an Issue and writes issue-work-map", async () => {
    const { ctx, store, issues, companyId } = makeCtx();
    await handleOrgWorkCreated(ctx, baseCfg, companyId, {
      org_id: "org_test",
      work_id: "work_abc",
      title: "Ship it",
      status: "todo",
    });
    assert.equal(issues.create.calls.length, 1);
    const createArg = issues.create.calls[0]![0] as {
      title: string;
      originId: string;
      originKind: string;
    };
    assert.equal(createArg.title, "[ACN] Ship it");
    assert.equal(createArg.originId, "work_abc");
    assert.match(createArg.originKind, /:work$/);
    const map = JSON.parse(store[STATE_KEYS.issueWorkMap]!) as Record<string, string>;
    assert.equal(map.work_abc, "iss-from-work");
  });

  it("skips when work_id already mapped", async () => {
    const { ctx, issues, companyId } = makeCtx({
      workMap: { work_abc: "iss-existing" },
    });
    await handleOrgWorkCreated(ctx, baseCfg, companyId, {
      org_id: "org_test",
      work_id: "work_abc",
      title: "Ship it",
    });
    assert.equal(issues.create.calls.length, 0);
  });

  it("skips recent outbound echo", async () => {
    noteRecentOutboundWork("work_echo");
    const { ctx, issues, companyId } = makeCtx();
    await handleOrgWorkCreated(ctx, baseCfg, companyId, {
      org_id: "org_test",
      work_id: "work_echo",
      title: "Echo",
    });
    assert.equal(issues.create.calls.length, 0);
  });

  it("binds to in-flight outbound issue (sync webhook during createWork)", async () => {
    const { ctx, store, issues, companyId } = makeCtx();
    beginOutboundWorkCreate(companyId, "iss-human", "Human title");
    try {
      await handleOrgWorkCreated(ctx, baseCfg, companyId, {
        org_id: "org_test",
        work_id: "work_sync",
        title: "Human title",
      });
    } finally {
      endOutboundWorkCreate(companyId, "iss-human");
    }
    assert.equal(issues.create.calls.length, 0);
    const map = JSON.parse(store[STATE_KEYS.issueWorkMap]!) as Record<string, string>;
    assert.equal(map.work_sync, "iss-human");
  });

  it("no-ops when org_id mismatches", async () => {
    const { ctx, issues, companyId } = makeCtx();
    await handleOrgWorkCreated(ctx, baseCfg, companyId, {
      org_id: "org_other",
      work_id: "work_abc",
      title: "Nope",
    });
    assert.equal(issues.create.calls.length, 0);
  });
});

describe("handleOrgWorkUpdated", () => {
  it("updates Issue to done", async () => {
    const { ctx, issues, companyId } = makeCtx({
      workMap: { work_abc: "iss-1" },
    });
    await handleOrgWorkUpdated(ctx, baseCfg, companyId, {
      org_id: "org_test",
      work_id: "work_abc",
      status: "done",
    });
    assert.equal(issues.update.calls.length, 1);
    assert.deepEqual(issues.update.calls[0]![1], { status: "done" });
    assert.equal(issues.createComment.calls.length, 1);
  });

  it("comments only for in_progress (no status update)", async () => {
    const { ctx, issues, companyId } = makeCtx({
      workMap: { work_abc: "iss-1" },
    });
    await handleOrgWorkUpdated(ctx, baseCfg, companyId, {
      org_id: "org_test",
      work_id: "work_abc",
      status: "in_progress",
      assignee_agent_id: "agt_worker",
    });
    assert.equal(issues.update.calls.length, 0);
    assert.equal(issues.createComment.calls.length, 1);
    assert.match(String(issues.createComment.calls[0]![1]), /in_progress/);
  });
});

describe("handleOrgLoopTick", () => {
  it("comments on every mapped open work in the tick", async () => {
    const { ctx, issues, companyId } = makeCtx({
      workMap: { work_a: "iss-a", work_b: "iss-b" },
    });
    await handleOrgLoopTick(ctx, baseCfg, companyId, {
      org_id: "org_test",
      open_count: 2,
      work_ids: ["work_a", "work_b"],
    });
    assert.equal(issues.create.calls.length, 0);
    assert.equal(issues.createComment.calls.length, 2);
    assert.deepEqual(
      issues.createComment.calls.map((c) => c[0]),
      ["iss-a", "iss-b"],
    );
  });

  it("throttles repeated ticks within cooldown", async () => {
    const { ctx, issues, companyId } = makeCtx({
      workMap: { work_a: "iss-a" },
    });
    await handleOrgLoopTick(ctx, baseCfg, companyId, {
      org_id: "org_test",
      open_count: 1,
      work_ids: ["work_a"],
    });
    await handleOrgLoopTick(ctx, baseCfg, companyId, {
      org_id: "org_test",
      open_count: 1,
      work_ids: ["work_a"],
    });
    assert.equal(issues.createComment.calls.length, 1);
  });
});
