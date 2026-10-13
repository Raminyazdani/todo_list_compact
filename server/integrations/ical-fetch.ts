import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

export interface IcalFeedPolicy {
  allowedHosts: readonly string[];
  maxBytes?: number;
  timeoutMs?: number;
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
        headers: { Accept: "text/calendar" },
        lookup: (_host, _options, callback) =>
          callback(null, chosen.address, chosen.family),
        timeout: policy.timeoutMs ?? 8000,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(
            new Error(
              "Calendar source returned a non-success status; redirects are blocked.",
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes)
            req.destroy(new Error("Calendar feed exceeds byte limit."));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (!text.includes("BEGIN:VCALENDAR"))
            reject(new Error("Source did not return an iCalendar document."));
          else resolve(text);
        });
        response.on("error", () =>
          reject(new Error("Calendar feed response could not be read.")),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("Calendar feed timed out.")));
    req.on("error", () => reject(new Error("Calendar feed unavailable.")));
    req.end();
  });
}
