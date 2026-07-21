/**
 * Unit tests for resolveAcnOrg (P2c C0).
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { AcnHttpError, type AcnOrgApi, type OrgRecord } from "../src/lib/org-api.ts";
import { resolveAcnOrg, type PluginConfig } from "../src/worker.ts";

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

function makeCtx(opts: { scalars?: Record<string, string> } = {}) {
  const scalars = { ...(opts.scalars ?? {}) };
  const logger = {
    info: spy(() => {}),
    warn: spy(() => {}),
    error: spy(() => {}),
    debug: spy(() => {}),
  };
  const ctx = {
    logger,
    state: {
      get: spy(async (q: { stateKey: string }) => scalars[q.stateKey] ?? null),
      set: spy(async (q: { stateKey: string }, value: string) => {
        scalars[q.stateKey] = value;
      }),
    },
  };
  return {
    ctx: ctx as unknown as PluginContext & typeof ctx,
    scalars,
    logger,
  };
}

function makeOrgApi(handlers: {
  getOrg?: (id: string) => Promise<OrgRecord>;
  createOrg?: (body: {
    display_name: string;
    subnet_id?: string;
  }) => Promise<OrgRecord>;
}) {
  const getOrg = spy(
    handlers.getOrg ??
      (async (id: string) => ({
        org_id: id,
        display_name: "X",
        fencing: { subnet_id: "fence-from-org" },
      })),
  );
  const createOrg = spy(
    handlers.createOrg ??
      (async () => ({
        org_id: "org_created",
        display_name: "Y",
        fencing: { subnet_id: "sub-1" },
      })),
  );
  return { getOrg, createOrg } as unknown as AcnOrgApi & {
    getOrg: typeof getOrg;
    createOrg: typeof createOrg;
  };
}

describe("resolveAcnOrg", () => {
  it("uses configured acnOrgId and backfills subnet from Org fence", async () => {
    const { ctx } = makeCtx();
    const orgApi = makeOrgApi({});
    const cfg: PluginConfig = { acnOrgId: "org_abc" };

    const id = await resolveAcnOrg(ctx, cfg, orgApi, "co-1", "Co");
    assert.equal(id, "org_abc");
    assert.equal(cfg.acnSubnetId, "fence-from-org");
    assert.equal(orgApi.createOrg.calls.length, 0);
  });

  it("warns and prefers Org fence when acnSubnetId mismatches", async () => {
    const { ctx, logger } = makeCtx();
    const orgApi = makeOrgApi({});
    const cfg: PluginConfig = {
      acnOrgId: "org_abc",
      acnSubnetId: "wrong-subnet",
    };

    await resolveAcnOrg(ctx, cfg, orgApi, "co-1", "Co");
    assert.equal(cfg.acnSubnetId, "fence-from-org");
    assert.ok(logger.warn.calls.length >= 1);
  });

  it("loads persisted org id from plugin state when config empty", async () => {
    const { ctx } = makeCtx({ scalars: { "acn-org-id": "org_persisted" } });
    const orgApi = makeOrgApi({});
    const cfg: PluginConfig = { acnSubnetId: "sub-1" };

    const id = await resolveAcnOrg(ctx, cfg, orgApi, "co-1", "Co");
    assert.equal(id, "org_persisted");
    assert.equal(orgApi.createOrg.calls.length, 0);
  });

  it("creates Org when neither config nor state has org id", async () => {
    const { ctx, scalars } = makeCtx();
    const orgApi = makeOrgApi({});
    const cfg: PluginConfig = { acnSubnetId: "sub-1" };

    const id = await resolveAcnOrg(ctx, cfg, orgApi, "co-1", "Acme");
    assert.equal(id, "org_created");
    assert.equal(scalars["acn-org-id"], "org_created");
    assert.equal(orgApi.createOrg.calls.length, 1);
    const [body] = orgApi.createOrg.calls[0] as [{ display_name: string; subnet_id: string }];
    assert.equal(body.display_name, "Acme");
    assert.equal(body.subnet_id, "sub-1");
  });

  it("reuses bound Org when create returns 409 with org id in message", async () => {
    const { ctx, scalars } = makeCtx();
    const orgApi = makeOrgApi({
      createOrg: async () => {
        throw new AcnHttpError(
          "POST",
          "/api/v1/orgs",
          409,
          JSON.stringify({
            error_code: "resource_conflict",
            message: "Subnet 'sub-1' is already bound to org org_deadbeef01",
            details: { reason: "subnet_already_bound" },
          }),
        );
      },
      getOrg: async (id) => ({
        org_id: id,
        display_name: "Bound",
        fencing: { subnet_id: "sub-1" },
      }),
    });
    const cfg: PluginConfig = { acnSubnetId: "sub-1" };

    const id = await resolveAcnOrg(ctx, cfg, orgApi, "co-1", "Co");
    assert.equal(id, "org_deadbeef01");
    assert.equal(scalars["acn-org-id"], "org_deadbeef01");
  });

  it("throws operator-facing error when 409 has no org hint", async () => {
    const { ctx } = makeCtx();
    const orgApi = makeOrgApi({
      createOrg: async () => {
        throw new AcnHttpError(
          "POST",
          "/api/v1/orgs",
          409,
          JSON.stringify({
            error_code: "resource_conflict",
            message: "conflict",
            details: { reason: "subnet_already_bound" },
          }),
        );
      },
    });
    const cfg: PluginConfig = { acnSubnetId: "sub-1" };

    await assert.rejects(
      () => resolveAcnOrg(ctx, cfg, orgApi, "co-1", "Co"),
      /Set instance config acnOrgId/,
    );
  });
});

describe("AcnHttpError", () => {
  it("parses reason and boundOrgIdHint from JSON body", () => {
    const err = new AcnHttpError(
      "POST",
      "/api/v1/orgs",
      409,
      JSON.stringify({
        message: "Subnet 'x' is already bound to org org_abc123def456",
        details: { reason: "subnet_already_bound" },
      }),
    );
    assert.equal(err.reason, "subnet_already_bound");
    assert.equal(err.boundOrgIdHint, "org_abc123def456");
  });
});
