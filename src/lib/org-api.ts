/**
 * Minimal Org Harness HTTP helpers (Phase 2c C0–C3).
 *
 * `acn-client` 0.13.x has no Org APIs yet — call REST directly until the
 * published SDK catches up. Keep this surface tiny: resolve/create Org +
 * create/update work items.
 */

export type OrgWorkStatus = "todo" | "in_progress" | "done" | "cancelled";

export interface OrgRecord {
  org_id: string;
  display_name: string;
  subnet_id?: string;
  fencing?: { subnet_id?: string };
  plugins?: Record<string, string>;
}

export interface OrgWorkItem {
  work_id: string;
  org_id: string;
  title: string;
  status: string;
  assignee_agent_id?: string | null;
}

/** Structured HTTP failure from ACN (keeps status + parsed JSON body). */
export class AcnHttpError extends Error {
  readonly status: number;
  readonly bodyText: string;
  readonly body: Record<string, unknown> | null;

  constructor(method: string, path: string, status: number, bodyText: string) {
    super(`ACN ${method} ${path} → ${status}: ${bodyText.slice(0, 300)}`);
    this.name = "AcnHttpError";
    this.status = status;
    this.bodyText = bodyText;
    let parsed: Record<string, unknown> | null = null;
    try {
      const v = JSON.parse(bodyText) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        parsed = v as Record<string, unknown>;
      }
    } catch {
      parsed = null;
    }
    this.body = parsed;
  }

  get reason(): string | undefined {
    const details = this.body?.details;
    if (details && typeof details === "object" && !Array.isArray(details)) {
      const r = (details as Record<string, unknown>).reason;
      return typeof r === "string" ? r : undefined;
    }
    return undefined;
  }

  /** Best-effort extract `org_…` from body/message (ACN may only put it in prose). */
  get boundOrgIdHint(): string | undefined {
    const details = this.body?.details;
    if (details && typeof details === "object" && !Array.isArray(details)) {
      const id = (details as Record<string, unknown>).bound_org_id;
      if (typeof id === "string" && id.startsWith("org_")) return id;
    }
    const msg =
      (typeof this.body?.message === "string" ? this.body.message : "") +
      " " +
      this.bodyText;
    const m = msg.match(/\borg_[0-9a-fA-F]+\b/);
    return m?.[0];
  }
}

export class AcnOrgApi {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private url(path: string): string {
    const base = this.baseUrl.replace(/\/$/, "");
    return `${base}${path.startsWith("/") ? path : `/${path}`}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AcnHttpError(method, path, res.status, text);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async getOrg(orgId: string): Promise<OrgRecord> {
    return this.request<OrgRecord>("GET", `/api/v1/orgs/${encodeURIComponent(orgId)}`);
  }

  async createOrg(opts: {
    display_name: string;
    subnet_id?: string;
    join_policy?: "open" | "approval";
  }): Promise<OrgRecord> {
    return this.request<OrgRecord>("POST", "/api/v1/orgs", {
      display_name: opts.display_name,
      subnet_id: opts.subnet_id,
      join_policy: opts.join_policy ?? "open",
    });
  }

  async createWork(
    orgId: string,
    opts: { title: string; assignee_agent_id?: string | null },
  ): Promise<OrgWorkItem> {
    const body: Record<string, unknown> = { title: opts.title };
    if (opts.assignee_agent_id != null && opts.assignee_agent_id !== "") {
      body.assignee_agent_id = opts.assignee_agent_id;
    }
    return this.request<OrgWorkItem>(
      "POST",
      `/api/v1/orgs/${encodeURIComponent(orgId)}/work`,
      body,
    );
  }

  async updateWorkStatus(
    orgId: string,
    workId: string,
    opts: { status: OrgWorkStatus; assignee_agent_id?: string | null },
  ): Promise<OrgWorkItem> {
    const body: Record<string, unknown> = { status: opts.status };
    if (opts.assignee_agent_id != null && opts.assignee_agent_id !== "") {
      body.assignee_agent_id = opts.assignee_agent_id;
    }
    return this.request<OrgWorkItem>(
      "PATCH",
      `/api/v1/orgs/${encodeURIComponent(orgId)}/work/${encodeURIComponent(workId)}`,
      body,
    );
  }
}

/** Prefer fencing.subnet_id, fall back to top-level subnet_id. */
export function orgSubnetId(org: OrgRecord): string | undefined {
  return org.fencing?.subnet_id || org.subnet_id || undefined;
}
