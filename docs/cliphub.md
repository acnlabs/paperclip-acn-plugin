# Paperclip Hub (cliphub.fyi) listing

## Status (2026-07-23)

The plugin is **already listed**:

- Directory page: https://cliphub.fyi/plugins/paperclip-plugin-acn  
- Registry pointer: [`registry/plugins/paperclip-plugin-acn.json`](https://github.com/lacymorrow/paperclip-hub/blob/main/registry/plugins/paperclip-plugin-acn.json)  
- Install: `npx paperclipai@latest plugin install @acnlabs/paperclip-plugin-acn`

**Problem:** the Hub’s *cached* manifest is still **0.1.1** (Task-centric copy). npm latest is **0.3.0** (Org work). Hub’s nightly `refresh-registry` workflow has been failing, so the page did not auto-bump.

## Pointer (already on Hub — no re-submit needed)

```json
{
  "$schema": "../schema.json",
  "npmPackage": "@acnlabs/paperclip-plugin-acn",
  "addedBy": "lacymorrow",
  "category": "integration",
  "sourceRepo": "https://github.com/acnlabs/paperclip-acn-plugin"
}
```

If you ever re-submit via https://cliphub.fyi/submit, use the same `npmPackage` / `category: integration`.

## Blurb (Hub / Discord / submit form)

**Short (≤160 chars):**  
Connect Paperclip Issues to ACN Org work — network org identity, subnet fence, two-way status sync.

**Medium:**  
Keep using Paperclip as your cockpit. This plugin maps human-created Issues to ACN Org Harness work items (`builtin_work`), registers a signed harness webhook for `org.work_*` / `org.loop_tick`, and PATCHes work when Issues complete. Not a Task Pool marketplace plugin (legacy Task mirror is opt-in).

**Install:**

```bash
npx paperclipai@latest plugin install @acnlabs/paperclip-plugin-acn
```

Docs: https://github.com/acnlabs/paperclip-acn-plugin · Quickstart: https://github.com/acnlabs/ACN/blob/main/docs/org-harness/quickstart-org-paperclip.md

## How to refresh Hub to 0.3.0

Pick one:

1. **Ask Hub maintainers** to re-run [Refresh registry manifests](https://github.com/lacymorrow/paperclip-hub/actions/workflows/refresh-registry.yml) (`workflow_dispatch`), or fix the failing nightly job.  
2. **Open a PR** on [lacymorrow/paperclip-hub](https://github.com/lacymorrow/paperclip-hub) updating `registry/manifests/paperclip-plugin-acn.json` to npm `0.3.0` (extract with their `bun scripts/registry/extract-manifest.ts`, or replace from a fresh pack of `@acnlabs/paperclip-plugin-acn@0.3.0` → `dist/manifest.js`).  
3. Re-submit via https://cliphub.fyi/submit if the form supports “update existing”.

Until refresh lands, the Hub card may still show old Task wording — **install from npm still gets 0.3.0**.
