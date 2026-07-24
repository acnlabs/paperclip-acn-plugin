/**
 * Periodic Org work sync (poll fallback).
 */

import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { STATE_KEYS } from "../src/constants.ts";
import type { AcnOrgApi, OrgWorkItem } from "../src/lib/org-api.ts";
import {
  clearRecentOutboundWorkForTests,
  syncOrgWorkFromAcn,
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

afterEach(() => {
  clearRecentOutboundWorkForTests();
});

function makeCtx(opts: {
  workMap?: Record<string, string>;
  issueStatus?: string;
} = {}) {
  const companyId = "co-1";
  const store: Record<string, string> = {
    [STATE_KEYS.issueWorkMap]: JSON.stringify(opts.workMap ?? {}),
  };
  const issues = {
    create: spy(async () => ({ id: "iss-new" })),
    update: spy(async () => {}),
    createComment: spy(async () => {}),
    get: spy(async () => ({ id: "iss-1", status: opts.issueStatus ?? "todo" })),
  };
  const ctx = {
    logger: {
      info: spy(() => {}),
      warn: spy(() => {}),
      error: spy(() => {}),
      debug: spy(() => {}),
    },
    state: {
      get: spy(async (q: { stateKey: string }) => store[q.stateKey] ?? null),
      set: spy(async (q: { stateKey: string }, value: string) => {
        store[q.stateKey] = value;
      }),
    },
    issues,
    companies: { list: spy(async () => [{ id: companyId }]) },
  };
  return { ctx: ctx as unknown as PluginContext & typeof ctx, store, issues, companyId };
}

const cfg: PluginConfig = {
  acnOrgId: "org_test",
  autoCreateIssues: true,
};

describe("syncOrgWorkFromAcn", () => {
  it("creates Issues for unmapped work", async () => {
    const { ctx, issues, companyId, store } = makeCtx();
    const work: OrgWorkItem[] = [
      {
        work_id: "work_1",
        org_id: "org_test",
        title: "From poll",
        status: "todo",
      },
    ];
    const orgApi = {
      listWork: spy(async () => work),
    } as unknown as AcnOrgApi;

    const stats = await syncOrgWorkFromAcn(ctx, cfg, orgApi, companyId);
    assert.equal(stats.created, 1);
    assert.equal(issues.create.calls.length, 1);
    const map = JSON.parse(store[STATE_KEYS.issueWorkMap]) as Record<string, string>;
    assert.equal(map.work_1, "iss-new");
  });

  it("updates Issue when ACN reaches terminal and Issue is still open", async () => {
    const { ctx, issues, companyId } = makeCtx({
      workMap: { work_1: "iss-1" },
      issueStatus: "todo",
    });
    const orgApi = {
      listWork: spy(async () => [
        {
          work_id: "work_1",
          org_id: "org_test",
          title: "Done on ACN",
          status: "done",
        },
      ]),
    } as unknown as AcnOrgApi;

    const stats = await syncOrgWorkFromAcn(ctx, cfg, orgApi, companyId);
    assert.equal(stats.updated, 1);
    assert.equal(issues.update.calls.length, 1);
    assert.deepEqual(issues.update.calls[0]?.[1], { status: "done" });
  });

  it("skips update when Issue already matches", async () => {
    const { ctx, issues, companyId } = makeCtx({
      workMap: { work_1: "iss-1" },
      issueStatus: "done",
    });
    const orgApi = {
      listWork: spy(async () => [
        {
          work_id: "work_1",
          org_id: "org_test",
          title: "Done",
          status: "done",
        },
      ]),
    } as unknown as AcnOrgApi;

    const stats = await syncOrgWorkFromAcn(ctx, cfg, orgApi, companyId);
    assert.equal(stats.updated, 0);
    assert.equal(issues.update.calls.length, 0);
  });

  it("does not backfill terminal unmapped work", async () => {
    const { ctx, issues, companyId } = makeCtx();
    const orgApi = {
      listWork: spy(async () => [
        {
          work_id: "work_old",
          org_id: "org_test",
          title: "Ancient",
          status: "done",
        },
      ]),
    } as unknown as AcnOrgApi;

    const stats = await syncOrgWorkFromAcn(ctx, cfg, orgApi, companyId);
    assert.equal(stats.created, 0);
    assert.equal(issues.create.calls.length, 0);
  });

  it("does not downgrade Paperclip in_progress when ACN is still todo", async () => {
    const { ctx, issues, companyId } = makeCtx({
      workMap: { work_1: "iss-1" },
      issueStatus: "in_progress",
    });
    const orgApi = {
      listWork: spy(async () => [
        {
          work_id: "work_1",
          org_id: "org_test",
          title: "Still open on ACN",
          status: "todo",
        },
      ]),
    } as unknown as AcnOrgApi;

    const stats = await syncOrgWorkFromAcn(ctx, cfg, orgApi, companyId);
    assert.equal(stats.updated, 0);
    assert.equal(issues.update.calls.length, 0);
  });
});
