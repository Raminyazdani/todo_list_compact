import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));
import { fetchIcalFeedConditional } from "../../server/integrations/ical-fetch";
const feed = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
let options: Record<string, unknown>,
  status = 200,
  stall = false;
beforeEach(() => {
  status = 200;
  stall = false;
  mocks.lookup
    .mockReset()
    .mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  mocks.request.mockReset().mockImplementation((_url, init, callback) => {
    options = init;
    const request = Object.assign(new EventEmitter(), {
      end: () => {
        if (!stall)
          queueMicrotask(() => {
            const response = Object.assign(new PassThrough(), {
              statusCode: status,
              headers: { etag: '"synthetic-etag"' },
            });
            callback(response);
            response.end(status === 200 ? feed : "");
            response.once("end", () => request.emit("close"));
          });
      },
      destroy: (error: Error) => {
        queueMicrotask(() => {
          request.emit("error", error);
          request.emit("close");
        });
        return request;
      },
    });
    return request;
  });
});
afterEach(() => {
  vi.useRealTimers();
});
describe("pinned private iCalendar HTTP transport", () => {
  it("pins one public address family so Node 24 does not request an incompatible all-address callback", async () => {
    expect(
      await fetchIcalFeedConditional(
        "https://feeds.example.invalid/private-synthetic",
        { allowedHosts: ["feeds.example.invalid"] },
      ),
    ).toMatchObject({ text: feed, notModified: false });
    expect(options.family).toBe(4);
    const callback = vi.fn();
    (options.lookup as (...args: unknown[]) => void)(
      "feeds.example.invalid",
      { all: false },
      callback,
    );
    expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
  });
  it("uses conditional headers and handles 304 without replacing the cached body", async () => {
    status = 304;
    expect(
      await fetchIcalFeedConditional(
        "https://feeds.example.invalid/private-synthetic",
        {
          allowedHosts: ["feeds.example.invalid"],
          etag: '"old"',
          lastModified: "Mon, 19 Oct 2026 10:00:00 GMT",
        },
      ),
    ).toEqual({ notModified: true, etag: '"synthetic-etag"' });
    expect(options.headers).toMatchObject({
      "If-None-Match": '"old"',
      "If-Modified-Since": "Mon, 19 Oct 2026 10:00:00 GMT",
    });
  });
  it("rejects mixed public/private DNS results before opening any connection", async () => {
    mocks.lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(
      fetchIcalFeedConditional(
        "https://feeds.example.invalid/private-synthetic",
        { allowedHosts: ["feeds.example.invalid"] },
      ),
    ).rejects.toThrow(/restricted/);
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it("applies a total request deadline even if no socket inactivity event fires", async () => {
    vi.useFakeTimers();
    stall = true;
    const request = fetchIcalFeedConditional(
      "https://feeds.example.invalid/private-synthetic",
      { allowedHosts: ["feeds.example.invalid"], timeoutMs: 8000 },
    );
    const rejected = expect(request).rejects.toMatchObject({
      name: "IcalFeedError",
      code: "ICAL_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(8000);
    await rejected;
  });
  it("returns sanitized HTTP status errors without disclosing the private feed URL", async () => {
    status = 403;
    const error = await fetchIcalFeedConditional(
      "https://feeds.example.invalid/private-synthetic-secret",
      { allowedHosts: ["feeds.example.invalid"] },
    ).catch((failure) => failure);
    expect(error).toMatchObject({
      code: "ICAL_HTTP_ERROR",
      upstream_status: 403,
    });
    expect(String(error) + JSON.stringify(error)).not.toContain(
      "private-synthetic-secret",
    );
  });
});
