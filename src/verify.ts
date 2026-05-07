import crypto from "node:crypto";

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || "";

export function verifySlackSignature(
  rawBody: string,
  timestamp: string | undefined,
  signature: string | undefined,
): boolean {
  if (!SIGNING_SECRET || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > 60 * 5) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const computed =
    "v0=" +
    crypto.createHmac("sha256", SIGNING_SECRET).update(base).digest("hex");
  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed, "utf8"),
      Buffer.from(signature, "utf8"),
    );
  } catch {
    return false;
  }
}
