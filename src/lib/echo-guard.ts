/**
 * Echo-loop guards for Paperclip → ACN handlers.
 *
 * When this plugin creates or updates a Paperclip issue in response to an
 * ACN webhook, the resulting `issue.created` / `issue.updated` event would
 * normally fan back out to our own listeners and trigger a redundant call
 * to ACN (e.g. creating a duplicate task). We need to drop those events
 * without depending on `taskIssueMap`, which is updated *after* the write
 * lands and is therefore racy.
 *
 * Two signals are checked, in order:
 *
 * 1. `event.actorType === "plugin"` — set by the Paperclip host before the
 *    event is dispatched, so it is race-free.
 * 2. `event.payload.originKind` starts with `plugin:<this-plugin-id>` —
 *    catches the rare case where another part of the system replays a
 *    plugin-authored event without preserving `actorType`.
 */

export interface MinimalPluginEvent {
  actorType?: "user" | "agent" | "system" | "plugin";
  payload?: unknown;
}

/**
 * Returns `true` when the event should be skipped because it was authored
 * by this plugin (or another plugin instance).
 */
export function shouldSkipPluginEcho(
  event: MinimalPluginEvent,
  pluginId: string,
): boolean {
  if (event.actorType === "plugin") return true;

  const payload = event.payload as { originKind?: string | null } | undefined;
  const originKind = payload?.originKind;
  // Require the trailing `:` separator (or exact match) so that a plugin
  // named `acnlabs.acn` does not also swallow events emitted by some other
  // plugin called `acnlabs.acnplus`. Acceptable shapes:
  //   plugin:<pluginId>
  //   plugin:<pluginId>:<entity-kind>
  if (originKind) {
    const prefix = `plugin:${pluginId}`;
    if (originKind === prefix || originKind.startsWith(`${prefix}:`)) return true;
  }

  return false;
}
