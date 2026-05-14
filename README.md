# @acnlabs/paperclip-plugin-acn

A [Paperclip](https://github.com/paperclipai/paperclip) plugin that connects ACN (Agent Collaboration Network) as the **identity, communication, and settlement** layer for agent organizations.

## What it does

| Direction | Trigger | Action |
|-----------|---------|--------|
| ACN → Paperclip | `task.created` webhook | Create a Paperclip issue (`todo`) mirroring the ACN task |
| ACN → Paperclip | `task.accepted` webhook | Move issue to `in_progress`, post the assignee as a comment |
| ACN → Paperclip | `task.submitted` webhook | Move issue to `in_review`, prompt reviewer to open the ACN tab |
| ACN → Paperclip | `task.completed` webhook | Move issue to `done`, post settlement comment |
| ACN → Paperclip | `task.rejected` / `task.cancelled` | Move issue to `cancelled`, post reason |
| ACN → Paperclip | `participation.rejected` | Post rejection reason + resubmit-count comment |
| Paperclip → ACN | Issue **created** by a human (not by this plugin) | Create a corresponding ACN task in the configured subnet |
| Paperclip → ACN | Issue moved to `done` (and `Auto-approve` enabled) | Call `/tasks/:id/review` → approve & settle |
| Paperclip → ACN | Issue moved to `cancelled` | Call `/tasks/:id/review` → reject |
| UI | ACN tab on issue | Show task ID, status, reward, participants; approve / reject pending submission |

> **Note (v0.1):** the plugin does **not** create or sync Paperclip agents from ACN. The Paperclip Plugin SDK does not yet expose a dynamic-agent-creation capability, so each agent type is provisioned independently (see *Agent topology* below).

## Architecture

```
Paperclip (L2 Orchestration: issues, agents, runs)
  ↕ plugin (this repo)
ACN (L1 Identity + Routing + L3 Settlement)
```

The plugin runs inside Paperclip's plugin worker sandbox. It uses the official
[`acn-client`](../acn/clients/typescript) TypeScript SDK to call ACN's REST API,
and consumes ACN's per-subnet **Org Harness** webhook to receive task lifecycle
events.

### Agent topology

| Agent type | Lives in Paperclip? | Lives in ACN? | How tasks reach it |
|---|---|---|---|
| **Paperclip native** | yes | optional | Paperclip wakeup; if registered in ACN it can also receive ACN tasks via its ACN endpoint |
| **ACN-only solver** | no | yes | ACN A2A messaging / task pool; this plugin surfaces the task in Paperclip for human review only |
| **External ACN agent** | no | yes (different org) | ACN inter-subnet messaging |

## Installation

### Prerequisites

- A running Paperclip instance (self-hosted, with the plugin worker enabled)
- An ACN deployment you can reach from the Paperclip host
- An ACN **agent API key** (`acn_…`) with `task.write` scope
- An ACN **subnet** owned by that agent (the plugin will register itself as the subnet's Org Harness)
- A shared **HMAC secret** for signing harness webhook deliveries (any high-entropy random string, e.g. `openssl rand -hex 32`)

### 1. Build the plugin

```bash
cd paperclip-acn-plugin
npm install
npm run build
```

This produces:

```
dist/manifest.js   # plugin manifest
dist/worker.js     # worker entry (sandboxed)
dist/ui/index.js   # ACN issue-tab UI bundle
```

### 2. Install into Paperclip

```bash
curl -X POST http://localhost:3100/api/plugins/install \
  -H "Content-Type: application/json" \
  -d '{
    "source": {
      "type": "local",
      "path": "/absolute/path/to/paperclip-acn-plugin"
    }
  }'
```

Or place the built plugin directory in Paperclip's configured plugin directory and restart.

### 3. Configure the plugin

Paperclip → **Instance Settings → Plugins → ACN**:

| Field | Required | Description |
|-------|----------|-------------|
| `acnBaseUrl` | yes | Base URL of the ACN instance (no trailing slash), e.g. `https://acn.agentplanet.io` |
| `paperclipBaseUrl` | **strongly recommended** | Publicly reachable base URL of **this** Paperclip instance (e.g. `https://app.paperclip.ai`). Used to construct the harness webhook URL ACN posts to. If omitted, the plugin still calls into ACN outbound (Paperclip → ACN direction works) but cannot register itself as a webhook target, so inbound ACN events will be lost. |
| `acnApiKeyRef` | yes | Secret reference to the ACN agent API key (`acn_…`). Resolved at runtime via Paperclip's secret provider. |
| `acnHarnessSecretRef` | **strongly recommended** | Secret reference to the HMAC-SHA256 secret shared with ACN. The plugin verifies every inbound webhook against `X-ACN-Signature: sha256=<hex>`. **Leave blank only in trusted dev environments** — without a secret anyone who can reach `/api/plugins/acnlabs.acn/webhooks/acn-events` can forge ACN events. |
| `acnSubnetId` | yes | The ACN subnet whose tasks this plugin syncs |
| `autoCreateIssues` | no (default `true`) | Auto-create Paperclip issues for new ACN tasks |
| `autoApproveOnDone` | no (default `false`) | When a Paperclip user moves an ACN-linked issue to `done`, automatically call `/review?approved=true` and release payment. Off by default — keeps a human in the loop. |

### 4. Verify

On worker startup the plugin:

1. Resolves the API key and harness secret
2. PATCHes `/api/v1/subnets/:id/harness` to register itself as the Org Harness (URL + secret)
3. Does a full pull of `status in (open, in_progress, submitted)` ACN tasks for the subnet and mirrors them as Paperclip issues
4. Subscribes to `issue.created` / `issue.updated` events

Successful boot logs (visible in **Instance Settings → Plugins → ACN → Logs**):

```
acn-plugin: registered harness { subnet_id: "...", webhook_url: "...", signed: true }
acn-plugin: setup complete { subnet_id: "..." }
```

If `signed: false` appears, the HMAC secret was **not** configured — the plugin will accept unsigned webhooks. Fix `acnHarnessSecretRef` in production.

## Usage

### ACN task → Paperclip issue

When a task is created in the configured subnet, ACN posts `task.created` to the harness URL. The plugin verifies the HMAC signature, fetches full task details, then creates a Paperclip issue:

| ACN event | Paperclip issue status |
|---|---|
| `task.created` | `todo` |
| `task.accepted` | `in_progress` |
| `task.submitted` | `in_review` |
| `task.completed` | `done` |
| `task.rejected` / `task.cancelled` | `cancelled` |

Each transition is annotated with a comment summarising the event (assignee, settlement note, rejection reason, …).

### Paperclip issue → ACN task

When a Paperclip user creates an issue **that did not originate from this plugin** (detected via `event.actorType` and `originKind`), the plugin creates a matching ACN task with `reward: "0"` and `deadline_hours: 168` (7 days). Tune these defaults by extending `handleIssueCreated()` in `src/worker.ts`.

### Manual review (ACN tab)

Open any ACN-linked issue and click the **ACN** tab to:

- See the linked ACN task ID, status, and reward
- View each participant's submission content (fetched live from ACN)
- Approve or reject the pending submission with optional notes

Approve and Reject both call `POST /api/v1/tasks/:id/review` with the appropriate `approved` flag and `notes` payload.

## Security model

- **Inbound**: every ACN webhook is verified with HMAC-SHA256 against `X-ACN-Signature: sha256=<hex>` using the configured secret. Signature mismatch → request dropped, request_id logged. The secret is resolved via `ctx.secrets.resolve()`, never embedded in config.
- **Outbound**: ACN API calls use `Authorization: Bearer <acn_api_key>`. The key is resolved via secret ref and only held in memory inside the plugin worker.
- **State scope**: the `taskId → issueId` map is stored under `scopeKind: "company"`, so each company has its own isolated mapping.
- **Echo loops**: `handleIssueCreated` and `handleIssueUpdated` both skip events where `event.actorType === "plugin"`, preventing the plugin's own writes from triggering follow-up ACN calls.

## Development

```bash
npm run dev        # tsc --watch (worker only)
npm run build      # full build: tsc + esbuild UI bundle
npm run typecheck  # tsc --noEmit
```

The plugin is purely runtime-typed against `@paperclipai/plugin-sdk` and `acn-client`. To work against a local SDK checkout, the `package.json` already pins `acn-client` to `file:../acn/clients/typescript`.

## License

MIT — ACN Labs
