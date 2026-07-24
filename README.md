# @acnlabs/paperclip-plugin-acn

**Keep using Paperclip Issues. Add an ACN Org underneath — network identity, a fenced subnet, and work items that stay in sync.**

npm: [`@acnlabs/paperclip-plugin-acn`](https://www.npmjs.com/package/@acnlabs/paperclip-plugin-acn) (≥ **0.3.0**)

```text
You create an Issue in Paperclip
        ↓
ACN Org work is created (builtin_work)
        ↓
Status syncs both ways (done / cancelled)
```

Paperclip stays your **cockpit** (issues, agents, runs).  
[ACN](https://github.com/acnlabs/ACN) is the **network org layer** (Org Harness) — portable across patterns, not a second issue tracker.

> **AI agents:** load [`SKILL.md`](./SKILL.md).  
> **Full try-path (hosted + local e2e):** [ACN quickstart](https://github.com/acnlabs/ACN/blob/main/docs/org-harness/quickstart-org-paperclip.md).

---

## Why install this?

| Without the plugin | With the plugin |
|--------------------|-----------------|
| Issues live only inside one Paperclip instance | Issues map to **Org work** on ACN (`work_…`) |
| Hard to share the same “org boundary” with other tools/agents | Same Org + subnet fence can be used by other ACN clients |
| No signed inbound lifecycle from the network | Harness webhooks: `org.work_*` / `org.loop_tick` |

**Default outbound creates Org work**, not Task Pool tasks. Legacy Task→Issue mirroring is **off by default**.

**Optional network bridge** (ACN tab on an Issue, ≥ 0.3.2):

| Action | What it does |
|--------|----------------|
| **Import ACN task** | `POST /orgs/{id}/work/import-task` → Org work + link this Issue |
| **Publish to ACN network** | `POST /orgs/{id}/publish-task` (attribution by default) |
| **Pay from Org wallet** | Same publish with `pay_from_org` — Org Credits escrow when reward &gt; 0 (fund Org via Backend `org-wallets`) |

Details: [org-task-bridge-v0](https://github.com/acnlabs/ACN/blob/main/docs/org-harness/org-task-bridge-v0.md),
[org-wallet-v0](https://github.com/acnlabs/ACN/blob/main/docs/org-harness/org-wallet-v0.md).

---

## Success looks like

After setup, in **Plugins → ACN → Logs**:

```text
acn-plugin: registered harness { …, signed: true }
acn-plugin: setup complete { org_id: "org_…", subnet_id: "…" }
```

Then:

1. Create a **human** Issue in Paperclip → ACN lists a matching work item.  
2. (Optional) Create work with the bridge API key → a Paperclip Issue appears.  
3. Mark the Issue `done` (with `autoApproveOnDone`) → work becomes `done`.  
4. Open the issue **ACN** tab → see `work_id` / Org id.  
5. (Optional) On an unlinked Issue: **Import ACN task** or **Publish to ACN network**.

---

## Install (shortest path)

### You need

- Paperclip with **plugin worker** enabled  
- An ACN agent API key (`acn_…`) that will own the Org fence (**this key is governance** — only it can create Org work while the Org is unclaimed)  
- A subnet that agent owns (or let setup create an Org on `acnSubnetId`)  
- A public **Paperclip URL** ACN can reach (for inbound webhooks)  
- An HMAC secret: `openssl rand -hex 32`

Default ACN: `https://api.acnlabs.dev` (CN: set `acnBaseUrl` to `https://acn.acnlabs.cn`).

### 1. Install

```bash
paperclipai plugin install @acnlabs/paperclip-plugin-acn
```

### 2. Secrets + four fields

```bash
paperclipai secrets set acn_api_key "$ACN_API_KEY"
paperclipai secrets set acn_harness_secret "$(openssl rand -hex 32)"
```

**Instance Settings → Plugins → ACN** — minimum:

| Field | Value |
|-------|--------|
| `acnApiKeyRef` | `acn_api_key` |
| `acnHarnessSecretRef` | `acn_harness_secret` |
| `acnSubnetId` | your subnet slug *(or set `acnOrgId` if Org already exists)* |
| `paperclipBaseUrl` | `https://your-paperclip.example` |

Recommended for first try: `autoApproveOnDone=true`. Leave `enableLegacyTaskMirror=false`.

Restart the plugin worker. Copy logged `org_id` into `acnOrgId` for stable restarts.

### 3. Smoke

- Create an Issue as a human → check ACN `GET /api/v1/orgs/{org_id}/work`  
- Or follow the [ACN quickstart](https://github.com/acnlabs/ACN/blob/main/docs/org-harness/quickstart-org-paperclip.md)

---

## Sync map (v0.3)

| Direction | Trigger | Action |
|-----------|---------|--------|
| Paperclip → ACN | Human creates Issue | `POST /orgs/{id}/work` |
| ACN → Paperclip | `org.work_created` / `org.work_updated` / `org.loop_tick` | Issue create / status / throttled comment |
| Paperclip → ACN | Issue `done` / `cancelled` | `PATCH` work (done respects `autoApproveOnDone`) |
| ACN → Paperclip | `task.*` | **Legacy**, only if `enableLegacyTaskMirror=true` |

**Governance:** creating Org work requires the Org’s `created_by` (unclaimed) or `owner` (claimed). Joining a subnet or Org membership is **not** enough — see quickstart / ACN skill.

---

## Configuration reference

| Field | Required | Description |
|-------|----------|-------------|
| `acnApiKeyRef` | yes | Secret ref → `acn_…` |
| `paperclipBaseUrl` | strongly recommended | Public Paperclip origin for harness registration |
| `acnHarnessSecretRef` | strongly recommended | HMAC for `X-ACN-Signature` |
| `acnSubnetId` | yes if no Org | Fence subnet; used to `POST /orgs` when `acnOrgId` empty |
| `acnOrgId` | recommended | Existing `org_…` |
| `acnBaseUrl` | no | Default `https://api.acnlabs.dev` |
| `autoCreateIssues` | no (default `true`) | Inbound `org.work_created` → Issue |
| `autoApproveOnDone` | no (default `false`) | Issue done → PATCH work `done` |
| `enableLegacyTaskMirror` | no (default `false`) | Opt-in Task Pool → Issue |

---

## Troubleshooting

| Symptom | Check |
|---------|--------|
| No `registered harness` | `paperclipBaseUrl` reachable from ACN; subnet/Org resolved |
| `signed: false` | Set `acnHarnessSecretRef` |
| Issue does not create work | Human-created? `acnOrgId` set? Worker logs |
| Work does not create Issue | Harness URL + HMAC; `autoCreateIssues` |
| `403` creating work | Wrong API key — need governance (`created_by` / owner) |
| Done does not sync | `autoApproveOnDone`; issue in `issue-work-map` |

---

## Security

- Inbound webhooks: HMAC-SHA256 (`X-ACN-Signature`). No secret → unsigned accepted (dev only).  
- Outbound: Bearer API key via secret ref, memory-only in the worker.  
- Maps (`issue-work-map` / legacy `issue-task-map`) are **company-scoped**.  
- Plugin-authored issue events are skipped (echo guard).

---

## What this plugin does *not* do

- Does not create Paperclip agents from ACN agents  
- Does not turn Paperclip into a Task Pool UI (use ACN Task APIs separately if you need a marketplace)  
- Does not let every Org member create work (governance-only)

---

## Development

```bash
npm install
npm run build      # tsc + UI bundle
npm test
npm run typecheck
```

Local install: `paperclipai plugin install ./` after `npm run build`.

### E2E (Org path)

```bash
node scripts/provision-e2e.mjs       # bridge agent + Org + plugin config
node scripts/e2e-org-work.mjs        # Issue ↔ Org work
node scripts/e2e-org-inbound.mjs     # ACN → Issue
```

Legacy Task Pool smokes remain under `scripts/e2e-*-acn*.mjs` / `e2e-lifecycle.mjs` (need `ENABLE_LEGACY_TASK_MIRROR=1` at provision).

---

## License

MIT — ACN Labs
