/**
 * Resolve a plugin config field that may hold either:
 *   1. A UUID-shaped Paperclip secret reference (resolved via the host) — used
 *      once Paperclip enables company-scoped plugin secret refs.
 *   2. A literal value (e.g. an ACN agent api_key or a hex-encoded HMAC secret)
 *      — used today, because the current Paperclip build hard-disables secret
 *      refs in plugin config (`PLUGIN_SECRET_REFS_DISABLED_MESSAGE`).
 *
 * This dual mode lets operators move forward without waiting for the upstream
 * "company-scoped plugin config" milestone and keeps the same code path live
 * once that lands — only the config value format flips.
 *
 * Decision is made purely on the **shape** of the ref string, never on
 * runtime errors, so a typo never silently leaks plaintext to the worker.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeSecretRef(value: string): boolean {
  return UUID_RE.test(value);
}

export interface SecretsResolver {
  resolve(ref: string): Promise<string>;
}

/**
 * @param ref      The config value (UUID secret ref OR literal).
 * @param secrets  The plugin host's secrets adapter (`ctx.secrets`).
 *
 * If `ref` is UUID-shaped, asks the host to resolve it.
 * Otherwise returns it verbatim.
 */
export async function resolveSecretOrLiteral(
  ref: string,
  secrets: SecretsResolver,
): Promise<string> {
  if (looksLikeSecretRef(ref)) {
    return secrets.resolve(ref);
  }
  return ref;
}
