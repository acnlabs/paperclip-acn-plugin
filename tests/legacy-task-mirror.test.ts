/**
 * Legacy Task Pool inbound gating (enableLegacyTaskMirror).
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { STATE_KEYS } from "../src/constants.ts";
import {
  clearRecentOutboundWorkForTests,
  handleAcnWebhook,
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

function makeCtx(opts: { taskMap?: Record<string, string> } = {}) {
  const companyId = "co-1";
  const store: Record<string, string> = {
    [STATE_KEYS.issueTaskMap]: JSON.stringify(opts.taskMap ?? {}),
  };
  const logger = {
    info: spy(() => {}),
    warn: spy(() => {}),
    error: spy(() => {}),
    debug: spy(() => {}),
  };
  const issues = {
    create: spy(async (input: { title?: string }) => ({
      id: "iss-from-task",
      title: input.title,
    })),
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

function makeClient(task?: { task_id: string; title: string }) {
  return {
    getTask: async () => task ?? null,
    listTasks: async () => ({ tasks: [] }),
  } as never;
}

const baseCfg: PluginConfig = {
  acnOrgId: "org_test",
  acnSubnetId: "sub-1",
  autoCreateIssues: true,
  enableLegacyTaskMirror: false,
};

afterEach(() => {
  clearRecentOutboundWorkForTests();
});

describe("enableLegacyTaskMirror", () => {
  it("skips task.created Issue create when flag is false", async () => {
    const { ctx, issues } = makeCtx();
    await handleAcnWebhook(
      ctx,
      baseCfg,
      makeClient({ task_id: "t_1", title: "Hello" }),
      JSON.stringify({
        event: "task.created",
        task_id: "t_1",
        data: { creator_id: "agent_other" },
      }),
    );
    assert.equal(issues.create.calls.length, 0);
  });

  it("creates Issue on task.created when flag is true", async () => {
    const { ctx, issues, store } = makeCtx();
    await handleAcnWebhook(
      ctx,
      { ...baseCfg, enableLegacyTaskMirror: true },
      makeClient({ task_id: "t_1", title: "Hello" }),
      JSON.stringify({
        event: "task.created",
        task_id: "t_1",
        data: { creator_id: "agent_other" },
      }),
    );
    assert.equal(issues.create.calls.length, 1);
    const map = JSON.parse(store[STATE_KEYS.issueTaskMap]!) as Record<string, string>;
    assert.equal(map["t_1"], "iss-from-task");
  });

  it("still comments mapped task.accepted when flag is false", async () => {
    const { ctx, issues } = makeCtx({ taskMap: { t_1: "iss-mapped" } });
    await handleAcnWebhook(
      ctx,
      baseCfg,
      makeClient(),
      JSON.stringify({
        event: "task.accepted",
        task_id: "t_1",
        data: { assignee_id: "agent_x" },
      }),
    );
    assert.equal(issues.create.calls.length, 0);
    assert.equal(issues.createComment.calls.length, 1);
    assert.equal(issues.createComment.calls[0]![0], "iss-mapped");
  });
});
