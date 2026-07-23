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

export class AcnOrgApi {
  private readonly client: ACNClient;

  constructor(baseUrl: string, apiKey: string) {
    this.client = new ACNClient({ baseUrl, apiKey });
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
}
