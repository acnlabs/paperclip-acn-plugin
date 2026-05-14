/**
 * HMAC-SHA256 signature verification for inbound ACN harness webhooks.
 *
 * ACN signs every harness webhook delivery with
 * `hmac_sha256(secret, raw_json_body).hexdigest()` and sends it in the
 * `X-ACN-Signature: sha256=<hex>` request header (see
 * `acn/protocols/ap2/webhook.py::_sign_payload`). The plugin worker is
 * solely responsible for verifying this signature — the Paperclip host
 * does not inspect plugin webhook bodies.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify the `X-ACN-Signature` header against `rawBody` using the shared
 * harness secret. Behaviour:
 *
 * - `secret === null` → returns `true` (no secret configured; operator has
 *   already been warned at setup time). Use this mode only in trusted dev
 *   environments.
 * - header missing / malformed → returns `false`.
 * - signature does not match → returns `false`.
 * - signature matches → returns `true`.
 *
 * Constant-time comparison via {@link timingSafeEqual} prevents byte-by-byte
 * timing oracles.
 */
export function verifyAcnSignature(
  headers: Record<string, string | string[]>,
  rawBody: string,
  secret: string | null,
): boolean {
  if (!secret) return true;

  const headerKey = Object.keys(headers).find(
    (k) => k.toLowerCase() === "x-acn-signature",
  );
  const raw = headerKey ? headers[headerKey] : undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return false;

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const got = value.startsWith("sha256=") ? value.slice(7) : value;
  if (got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}
