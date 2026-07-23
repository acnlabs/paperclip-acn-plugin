/**
 * Org Harness helpers for the Paperclip plugin.
 *
 * Thin wrapper over `acn-client` ≥ 0.15.0 Work Port APIs. Kept as a small
 * façade so worker/tests can mock `AcnOrgApi` without stubbing the whole SDK.
 */

import {
  ACNClient,
  ACNError,
  orgSubnetId,
  type Org,
  type OrgWorkItem,
  type OrgWorkStatus,
} from "acn-client";

export type { OrgWorkItem, OrgWorkStatus };
export type OrgRecord = Org;
export { orgSubnetId, ACNError };

/**
 * Compatibility error used by tests and resolveAcnOrg conflict handling.
 * Prefer catching `ACNError` from `acn-client` in new code.
 */
export class AcnHttpError extends ACNError {
  readonly bodyText: string;

  constructor(method: string, path: string, status: number, bodyText: string) {
    let body: Record<string, unknown> | undefined;
    try {
      const v = JSON.parse(bodyText) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        body = v as Record<string, unknown>;
      }
    } catch {
      body = undefined;
    }
    const message =
      (typeof body?.message === "string" && body.message) ||
      `ACN ${method} ${path} → ${status}: ${bodyText.slice(0, 300)}`;
    super(status, message, { body });
    this.name = "AcnHttpError";
    this.bodyText = bodyText;
  }
}

export type OrgWorkImportResult = OrgWorkItem & {
  source_task_id?: string;
  already_imported?: boolean;
};

export type OrgPublishedTask = {
  task_id: string;
  title: string;
  status: string;
  subnet_slug?: string | null;
  metadata?: Record<string, unknown>;
};

export class AcnOrgApi {
  private readonly client: ACNClient;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.client = new ACNClient({ baseUrl: this.baseUrl, apiKey });
  }

  getOrg(orgId: string): Promise<OrgRecord> {
    return this.client.getOrg(orgId);
  }

  createOrg(opts: {
    display_name: string;
    subnet_id?: string;
    join_policy?: "open" | "approval";
  }): Promise<OrgRecord> {
    return this.client.createOrg({
      display_name: opts.display_name,
      subnet_id: opts.subnet_id,
      join_policy: opts.join_policy ?? "open",
    });
  }

  createWork(
    orgId: string,
    opts: { title: string; assignee_agent_id?: string | null },
  ): Promise<OrgWorkItem> {
    return this.client.createWork(orgId, opts);
  }

  updateWorkStatus(
    orgId: string,
    workId: string,
    opts: { status: OrgWorkStatus; assignee_agent_id?: string | null },
  ): Promise<OrgWorkItem> {
    return this.client.updateWork(orgId, workId, opts);
  }

  /**
   * Import a Task Pool task as Org work (ACN org-task-bridge-v0).
   * Not yet on `acn-client` — raw HTTP until SDK grows the method.
   */
  importWorkFromTask(
    orgId: string,
    opts: { task_id: string; assignee_agent_id?: string | null },
  ): Promise<OrgWorkImportResult> {
    return this.postJson<OrgWorkImportResult>(
      `/api/v1/orgs/${encodeURIComponent(orgId)}/work/import-task`,
      {
        task_id: opts.task_id,
        ...(opts.assignee_agent_id
          ? { assignee_agent_id: opts.assignee_agent_id }
          : {}),
      },
    );
  }

  /**
   * Publish a network Task attributed to an Org (`metadata.org_id`).
   * Uses agent create path; `acn-client` TaskCreateRequest omits metadata today.
   */
  publishTaskForOrg(
    orgId: string,
    opts: {
      title: string;
      description: string;
      required_tags: string[];
      reward?: string;
      reward_currency?: string;
      deadline_hours?: number;
      task_type?: string;
    },
  ): Promise<OrgPublishedTask> {
    return this.postJson<OrgPublishedTask>("/api/v1/tasks/agent/create", {
      title: opts.title,
      description: opts.description,
      required_tags: opts.required_tags,
      reward: opts.reward ?? "0",
      reward_currency: opts.reward_currency ?? "ap_points",
      deadline_hours: opts.deadline_hours ?? 48,
      task_type: opts.task_type ?? "general",
      metadata: { org_id: orgId, org_publish: true },
    });
  }

  private async postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new AcnHttpError("POST", path, res.status, text);
    }
    return JSON.parse(text) as T;
  }
}
