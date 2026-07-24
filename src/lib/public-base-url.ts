/**
 * Resolve a Paperclip base URL that hosted ACN can call back to.
 *
 * Preference: explicit plugin config → PAPERCLIP_PUBLIC_URL env (host).
 * Loopback / private hosts are fine for local ACN (dev_mode) but hosted
 * ACN rejects them as harness URLs (SSRF guard).
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

export function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True for localhost / RFC1918 / link-local — ACN hosted will reject these. */
export function isPrivateOrLoopbackUrl(url: string): boolean {
  const host = hostnameOf(url);
  if (!host) return true;
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (host.endsWith(".local")) return true;
  // IPv4 private / link-local
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  return false;
}

export function isHostedAcnBase(acnBaseUrl: string | undefined): boolean {
  const base = (acnBaseUrl ?? "").trim().toLowerCase();
  if (!base) return true;
  try {
    const host = new URL(base).hostname;
    if (LOOPBACK_HOSTS.has(host) || host.endsWith(".local")) return false;
    return true;
  } catch {
    return true;
  }
}

/**
 * Best public Paperclip origin for harness registration.
 * Empty string when nothing usable is configured.
 */
export function resolvePaperclipPublicBaseUrl(opts: {
  paperclipBaseUrl?: string;
  envPublicUrl?: string | null;
}): string {
  const fromCfg = (opts.paperclipBaseUrl ?? "").trim().replace(/\/$/, "");
  if (fromCfg) return fromCfg;
  const fromEnv = (opts.envPublicUrl ?? process.env.PAPERCLIP_PUBLIC_URL ?? "")
    .trim()
    .replace(/\/$/, "");
  return fromEnv;
}

export type HarnessSkipReason =
  | "missing_base_url"
  | "private_or_loopback"
  | "register_failed"
  | null;

/**
 * Whether we should attempt harness registration against this ACN.
 * Against hosted ACN, skip private/loopback bases (would only ERROR).
 */
export function shouldAttemptHarnessRegister(opts: {
  acnBaseUrl?: string;
  publicBaseUrl: string;
}): { attempt: boolean; reason: HarnessSkipReason } {
  const base = opts.publicBaseUrl.trim();
  if (!base) return { attempt: false, reason: "missing_base_url" };
  if (isHostedAcnBase(opts.acnBaseUrl) && isPrivateOrLoopbackUrl(base)) {
    return { attempt: false, reason: "private_or_loopback" };
  }
  return { attempt: true, reason: null };
}
