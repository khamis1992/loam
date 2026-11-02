import type { IncomingMessage } from "node:http";

/**
 * The desktop shell is `app://agent`. Its calls to the loopback server are
 * cross-site by fetch metadata, and that is not a hostile website.
 * A real page on another host stays rejected.
 */
export function isHostileCrossSite(req: IncomingMessage): boolean {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  if (origin === "app://agent") return false;
  const host = typeof req.headers.host === "string" ? req.headers.host : "";
  const foreign = origin.length > 0 && origin !== `http://${host}` && origin !== `https://${host}`;
  return foreign || req.headers["sec-fetch-site"] === "cross-site";
}
