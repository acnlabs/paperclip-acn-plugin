import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { AcnHttpError, AcnOrgApi } from "../src/lib/org-api.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("AcnOrgApi Task Pool bridge helpers", () => {
  it("importWorkFromTask posts import-task and returns body", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          work_id: "work_abc",
          org_id: "org_x",
          title: "T",
          status: "todo",
          already_imported: false,
          source_task_id: "task_1",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const api = new AcnOrgApi("https://api.example", "acn_key");
    const res = await api.importWorkFromTask("org_x", { task_id: "task_1" });
    assert.equal(res.work_id, "work_abc");
    assert.equal(res.already_imported, false);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/api\/v1\/orgs\/org_x\/work\/import-task$/);
    assert.equal(calls[0]!.init?.method, "POST");
    const body = JSON.parse(String(calls[0]!.init?.body));
    assert.deepEqual(body, { task_id: "task_1" });
  });

  it("publishTaskForOrg posts org publish-task (attribution)", async () => {
    let url = "";
    let body: Record<string, unknown> | null = null;
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      url = String(u);
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          task_id: "task_new",
          title: "Need help",
          status: "open",
          creator_type: "agent",
          metadata: { org_id: "org_x", org_publish: true },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const api = new AcnOrgApi("https://api.example/", "acn_key");
    const res = await api.publishTaskForOrg("org_x", {
      title: "Need help",
      description: "Please review the adapter changes.",
      required_tags: ["review"],
    });
    assert.equal(res.task_id, "task_new");
    assert.match(url, /\/api\/v1\/orgs\/org_x\/publish-task$/);
    assert.ok(body);
    assert.equal(body!.title, "Need help");
    assert.equal(body!.pay_from_org, false);
    assert.equal(body!.reward, "0");
  });

  it("publishTaskForOrg pay_from_org sends flag and reward", async () => {
    let body: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          task_id: "task_paid",
          title: "Bounty",
          status: "open",
          creator_type: "org",
          creator_id: "org_x",
          reward_currency: "credits",
          use_escrow: true,
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const api = new AcnOrgApi("https://api.example", "acn_key");
    const res = await api.publishTaskForOrg("org_x", {
      title: "Bounty task here",
      description: "Please complete this paid org bounty.",
      required_tags: ["coding"],
      reward: "100",
      pay_from_org: true,
    });
    assert.equal(res.creator_type, "org");
    assert.equal(res.use_escrow, true);
    assert.ok(body);
    assert.equal(body!.pay_from_org, true);
    assert.equal(body!.reward, "100");
  });

  it("maps non-2xx to AcnHttpError", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "nope" }), { status: 403 })) as typeof fetch;
    const api = new AcnOrgApi("https://api.example", "acn_key");
    await assert.rejects(
      () => api.importWorkFromTask("org_x", { task_id: "task_1" }),
      (err: unknown) => err instanceof AcnHttpError && err.status === 403,
    );
  });
});
