import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

export interface IcalFeedPolicy {
  allowedHosts: readonly string[];
  maxBytes?: number;
  timeoutMs?: number;
  etag?: string;
  lastModified?: string;
}
export interface IcalFeedResponse {
  text?: string;
  notModified: boolean;
  etag?: string;
  lastModified?: string;
}
export class IcalFeedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly upstream_status?: number,
  ) {
    super(message);
    this.name = "IcalFeedError";
  }
}
function transportCode(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "UNKNOWN";
  return /^[A-Z0-9_]{2,60}$/.test(code) ? code : "UNKNOWN";
}
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    if (lower.startsWith("::ffff:")) return isPublicAddress(lower.slice(7));
    return (
      /^2[0-9a-f]{3}:/.test(lower) &&
      !lower.startsWith("2001:db8:") &&
      !lower.startsWith("2002:") &&
      !/^2001:0{1,4}:/.test(lower)
    );
  }
  return false;
}
/** Explicit HTTPS host allowlist + pinned resolved public IP + zero redirects. */
export async function fetchIcalFeed(
  rawUrl: string,
  policy: IcalFeedPolicy,
): Promise<string> {
  const result = await fetchIcalFeedConditional(rawUrl, {
    ...policy,
    etag: undefined,
    lastModified: undefined,
  });
  return result.text!;
}
export async function fetchIcalFeedConditional(
  rawUrl: string,
  policy: IcalFeedPolicy,
): Promise<IcalFeedResponse> {
  const url = new URL(rawUrl);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !policy.allowedHosts
      .map((h) => h.toLowerCase())
      .includes(url.hostname.toLowerCase()) ||
    isIP(url.hostname)
  )
    throw new Error("Calendar feed host is not allowed.");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
    throw new Error("Calendar host resolves to a restricted address.");
  const chosen = addresses[0],
    maxBytes = policy.maxBytes ?? 2 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        // A pinned family disables Node's automatic multi-address lookup mode.
        // Its `all:true` callback shape differs from the single pinned address
        // callback, and otherwise produces ERR_INVALID_IP_ADDRESS on Node 24.
        family: chosen.family,
        headers: {
          Accept: "text/calendar",
          ...(policy.etag ? { "If-None-Match": policy.etag } : {}),
          ...(policy.lastModified
            ? { "If-Modified-Since": policy.lastModified }
            : {}),
        },
        lookup: (_host, _options, callback) =>
          callback(null, chosen.address, chosen.family),
        timeout: policy.timeoutMs ?? 8000,
      },
      (response) => {
        const metadata = {
          ...(typeof response.headers.etag === "string"
            ? { etag: response.headers.etag }
            : {}),
          ...(typeof response.headers["last-modified"] === "string"
            ? { lastModified: response.headers["last-modified"] }
            : {}),
        };
        if (response.statusCode === 304) {
          response.resume();
          resolve({ notModified: true, ...metadata });
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new IcalFeedError(
              "ICAL_HTTP_ERROR",
              "Calendar source returned a non-success status; redirects are blocked.",
              response.statusCode,
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes)
            req.destroy(
              new IcalFeedError(
                "ICAL_FEED_TOO_LARGE",
                "Calendar feed exceeds byte limit.",
              ),
            );
          else chunks.push(chunk);
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (!text.includes("BEGIN:VCALENDAR"))
            reject(new Error("Source did not return an iCalendar document."));
          else resolve({ text, notModified: false, ...metadata });
        });
        response.on("error", () =>
          reject(new Error("Calendar feed response could not be read.")),
        );
      },
    );
    const deadline = setTimeout(
      () =>
        req.destroy(
          new IcalFeedError(
            "ICAL_TIMEOUT",
            "Calendar feed exceeded its total request budget.",
          ),
        ),
      policy.timeoutMs ?? 8000,
    );
    deadline.unref();
    req.once("close", () => clearTimeout(deadline));
    req.on("timeout", () =>
      req.destroy(
        new IcalFeedError("ICAL_TIMEOUT", "Calendar feed timed out."),
      ),
    );
    req.on("error", (error) =>
      reject(
        error instanceof IcalFeedError
          ? error
          : new IcalFeedError(
              "ICAL_TRANSPORT_" + transportCode(error),
              "Calendar feed unavailable.",
            ),
      ),
    );
    req.end();
  });
}
