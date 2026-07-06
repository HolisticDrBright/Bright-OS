import crypto from "node:crypto";

/**
 * HMAC scheme for inbound webhooks (heartbeat ingest, OpenClaw skill):
 *   x-brightos-timestamp: unix seconds
 *   x-brightos-signature: hex(HMAC_SHA256(secret, `${timestamp}.${rawBody}`))
 * Timestamp must be within ±300s to kill replays.
 */
export const HMAC_WINDOW_S = 300;

export function signHeartbeat(secret: string, timestamp: string, rawBody: string): string {
  return crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export function verifyHeartbeatSignature(opts: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  nowS?: number;
}): { ok: true } | { ok: false; reason: string } {
  const { secret, timestamp, signature, rawBody } = opts;
  if (!secret) return { ok: false, reason: "server has no HEARTBEAT_HMAC_SECRET configured" };
  if (!timestamp || !signature) return { ok: false, reason: "missing signature headers" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad timestamp" };
  const now = opts.nowS ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > HMAC_WINDOW_S) return { ok: false, reason: "timestamp outside replay window" };
  const expected = signHeartbeat(secret, timestamp, rawBody);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}
