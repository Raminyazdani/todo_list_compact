/** Read-only owner UI evidence. Private HTML/screenshots never belong in Git. */
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { queryTransactionMode } from "../../server/domain/query-transaction-mode.ts";
import { boundedSignIn } from "./bounded-signin.mjs";
import {
  admitPrivatePath,
  writeExclusivePrivateJson,
} from "./private-paths.mjs";

export const REPOSITORY = fileURLToPath(new URL("../../", import.meta.url));
export const CAPTURE_ORIGIN = "https://ramin-life-os.vercel.app";
export const DESIGN_ROUTES = [
  ["today", "/"],
  ["tasks", "/tasks"],
  ["projects", "/projects"],
  ["calendar", "/calendar"],
  ["work", "/time"],
  ["routines", "/routines"],
  ["finances", "/finances"],
  ["files", "/files"],
  ["reports", "/reports"],
  ["settings", "/settings"],
];
const routePaths = new Set(DESIGN_ROUTES.map(([, path]) => path));
const omittedQueries = new Set([
  "backup_export",
  "finance_export",
  "export_data_manifest",
  "time_entry_export",
]);
export const VISUAL_LIMIT = 12 * 1024 * 1024;
const allowedWidths = new Set([390, 768, 1440]);
export const viewportFor = (width) => ({
  width,
  height: width === 390 ? 844 : width === 768 ? 1024 : 1000,
});
export const INERT_CSP =
  "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";

function check(condition, code) {
  if (!condition) throw new Error(code);
}

export function parseArguments(argv, intent, permitted) {
  check(argv[0] === intent, "DESIGN_EXPLICIT_INTENT_REQUIRED");
  const args = {};
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    check(
      permitted.includes(name) &&
        !(name in args) &&
        typeof argv[index + 1] === "string" &&
        !argv[index + 1].startsWith("--"),
      "DESIGN_ARGUMENTS_INVALID",
    );
    args[name] = argv[index + 1];
  }
  return args;
}

export function parseWidths(value = "1440,768,390") {
  const widths = value.split(",").map(Number);
  check(
    widths.length > 0 &&
      widths.length <= 3 &&
      new Set(widths).size === widths.length &&
      widths.every((width) => allowedWidths.has(width)),
    "DESIGN_WIDTHS_INVALID",
  );
  return widths;
}

export function isInside(root, target) {
  const suffix = relative(root.toLowerCase(), target.toLowerCase());
  return (
    suffix === "" ||
    (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(".." + sep))
  );
}

export async function privateDirectory(
  candidate,
  { create = false, empty = false } = {},
) {
  check(
    typeof candidate === "string" && isAbsolute(candidate),
    "DESIGN_PRIVATE_DIRECTORY_REQUIRED",
  );
  const repository = await realpath(REPOSITORY);
  const lexical = resolve(candidate);
  check(!isInside(repository, lexical), "DESIGN_OUTPUT_INSIDE_GIT");
  const parent = await realpath(dirname(lexical));
  check(
    parent.toLowerCase() === dirname(lexical).toLowerCase(),
    "DESIGN_DIRECTORY_REDIRECTION",
  );
  try {
    await lstat(lexical);
  } catch (error) {
    if (error.code !== "ENOENT" || !create) throw error;
    await mkdir(lexical, { mode: 0o700 });
  }
  const stat = await lstat(lexical);
  const canonical = await realpath(lexical);
  check(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      canonical.toLowerCase() === lexical.toLowerCase() &&
      !isInside(repository, canonical),
    "DESIGN_PRIVATE_DIRECTORY_INVALID",
  );
  if (empty)
    check((await readdir(canonical)).length === 0, "DESIGN_OUTPUT_NOT_EMPTY");
  return canonical;
}

export async function readPrivateFile(candidate, limit = VISUAL_LIMIT) {
  const target = await admitPrivatePath(candidate, {
    repositoryRoot: REPOSITORY,
    mustExist: true,
  });
  check(
    resolve(candidate).toLowerCase() === target.toLowerCase(),
    "DESIGN_PRIVATE_FILE_REDIRECTION",
  );
  const handle = await open(target, "r");
  try {
    const stat = await handle.stat();
    const current = await lstat(target);
    check(
      stat.isFile() &&
        stat.nlink === 1 &&
        stat.dev === current.dev &&
        stat.ino === current.ino &&
        stat.size <= limit,
      "DESIGN_PRIVATE_FILE_INVALID",
    );
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function writePrivateBytes(candidate, data) {
  const target = await admitPrivatePath(candidate, {
    repositoryRoot: REPOSITORY,
  });
  check(Buffer.byteLength(data) <= VISUAL_LIMIT, "DESIGN_ARTIFACT_TOO_LARGE");
  const handle = await open(target, "wx", 0o600);
  try {
    await admitPrivatePath(target, {
      repositoryRoot: REPOSITORY,
      mustExist: true,
    });
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return target;
}

export function isPublicAsset(url) {
  return (
    url.origin === CAPTURE_ORIGIN &&
    !url.username &&
    !url.password &&
    (url.pathname.startsWith("/_next/static/") ||
      url.pathname.startsWith("/fonts/") ||
      url.pathname.startsWith("/icons/")) &&
    /\.(?:css|woff2?|ttf|otf|png|jpe?g|webp|gif|avif|ico|svg)$/i.test(
      url.pathname,
    )
  );
}

function readQueryAllowed(operation) {
  return (
    typeof operation === "string" &&
    queryTransactionMode(operation) === "read" &&
    !omittedQueries.has(operation)
  );
}

/** Fail closed: a query URL must name a classified read, not a command/preview. */
export function requestAdmission(rawUrl, method, postData) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.origin !== CAPTURE_ORIGIN || url.username || url.password)
    return false;
  if (url.pathname === "/api/v1/query" && ["GET", "POST"].includes(method)) {
    try {
      const body =
        method === "GET"
          ? {
              operation: url.searchParams.get("operation"),
              input: JSON.parse(url.searchParams.get("input") ?? "{}"),
            }
          : JSON.parse(postData ?? "");
      return (
        (postData?.length ?? 0) <= 512 * 1024 &&
        body &&
        !Array.isArray(body) &&
        typeof body === "object" &&
        Object.keys(body).every((key) =>
          ["operation", "input"].includes(key),
        ) &&
        readQueryAllowed(body.operation) &&
        (body.input === undefined ||
          (body.input &&
            typeof body.input === "object" &&
            !Array.isArray(body.input)))
      );
    } catch {
      return false;
    }
  }
  if (!["GET", "HEAD"].includes(method)) return false;
  return (
    routePaths.has(url.pathname) ||
    url.pathname.startsWith("/_next/static/") ||
    isPublicAsset(url) ||
    [
      "/api/auth/get-session",
      "/api/v1/connections",
      "/api/health",
      "/manifest.webmanifest",
    ].includes(url.pathname)
  );
}

async function readBoundedResponse(response, limit) {
  check(response.ok, "DESIGN_PUBLIC_ASSET_REQUEST_FAILED");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      check(total <= limit, "DESIGN_PUBLIC_ASSET_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

export async function replaceAsync(text, pattern, replace) {
  let output = "";
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    output += text.slice(cursor, match.index) + (await replace(match));
    cursor = match.index + match[0].length;
  }
  return output + text.slice(cursor);
}

function assetFetcher() {
  const cache = new Map();
  return async (rawUrl) => {
    const url = new URL(rawUrl);
    check(isPublicAsset(url), "DESIGN_ONLY_PUBLIC_STATIC_ASSETS_ALLOWED");
    if (!cache.has(url.href)) {
      const response = await fetch(url, {
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(15000),
      });
      const bytes = await readBoundedResponse(response, 4 * 1024 * 1024);
      const mime = (response.headers.get("content-type") ?? "")
        .split(";")[0]
        .toLowerCase();
      check(
        /^(?:text\/css|font\/[a-z0-9.+-]+|image\/[a-z0-9.+-]+|application\/(?:font-woff|x-font-ttf|octet-stream))$/.test(
          mime,
        ),
        "DESIGN_STATIC_ASSET_TYPE_REJECTED",
      );
      cache.set(url.href, { bytes, mime });
    }
    return cache.get(url.href);
  };
}

async function inlinePublicCss(text, baseUrl, asset) {
  check(Buffer.byteLength(text) <= VISUAL_LIMIT, "DESIGN_STYLES_TOO_LARGE");
  // Compiled Next styles have no imports. Never follow arbitrary import targets.
  text = text.replace(/@import\s+(?:url\([^)]*\)|["'][^"']*["'])[^;]*;/gi, "");
  return replaceAsync(
    text,
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/gi,
    async (match) => {
      const reference = match[1] ?? match[2] ?? match[3];
      if (
        /^data:(?:image\/|font\/|application\/font-woff)/i.test(reference) ||
        reference.startsWith("#")
      )
        return match[0];
      const url = new URL(reference, baseUrl);
      if (!isPublicAsset(url)) return 'url("data:,")';
      const result = await asset(url.href);
      return `url("data:${result.mime};base64,${result.bytes.toString("base64")}")`;
    },
  );
}

/** Runs on a cloned document only. No live app DOM or preference is changed. */
export function sanitizeDocument({ css, imageMap, csp }) {
  const clone = document.documentElement.cloneNode(true);
  const liveControls = [...document.querySelectorAll("input,textarea,select")];
  const clonedControls = [...clone.querySelectorAll("input,textarea,select")];
  for (let index = 0; index < liveControls.length; index++) {
    const source = liveControls[index];
    const target = clonedControls[index];
    if (source.tagName === "TEXTAREA") target.textContent = source.value;
    else if (source.tagName === "SELECT") {
      [...target.options].forEach((option, optionIndex) => {
        option.toggleAttribute(
          "selected",
          source.options[optionIndex].selected,
        );
      });
    } else if (!["password", "hidden", "file"].includes(source.type)) {
      target.setAttribute("value", source.value);
      target.toggleAttribute("checked", source.checked);
    } else target.removeAttribute("value");
  }
  for (const node of clone.querySelectorAll(
    "script,noscript,iframe,frame,frameset,object,embed,base,link,style,meta,foreignObject,template,animate,animateMotion,animateTransform,set,audio,video,source,track",
  ))
    node.remove();
  for (const node of clone.querySelectorAll("*")) {
    for (const { name } of [...node.attributes]) {
      if (
        /^on/i.test(name) ||
        [
          "action",
          "formaction",
          "target",
          "formtarget",
          "ping",
          "srcdoc",
          "srcset",
          "poster",
          "nonce",
          "integrity",
          "contenteditable",
          "autofocus",
        ].includes(name.toLowerCase())
      )
        node.removeAttribute(name);
    }
    for (const name of ["href", "xlink:href"]) {
      const value = node.getAttribute(name);
      if (value && !value.startsWith("#")) node.removeAttribute(name);
    }
    if (node.hasAttribute("src")) {
      const source = node.getAttribute("src");
      const embedded =
        imageMap[source] ?? imageMap[new URL(source, document.baseURI).href];
      if (node.tagName === "IMG" && embedded)
        node.setAttribute("src", embedded);
      else node.removeAttribute("src");
    }
    if (node.tagName === "BUTTON") node.setAttribute("type", "button");
    if (
      node.tagName === "INPUT" &&
      ["password", "hidden", "file"].includes(node.type)
    )
      node.removeAttribute("value");
    if (node.hasAttribute("style"))
      node.setAttribute(
        "style",
        node
          .getAttribute("style")
          .replace(
            /url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]*))\s*\)/gi,
            (match, quoted, single, plain) =>
              /^(?:data:|#)/i.test(quoted ?? single ?? plain)
                ? match
                : 'url("data:,")',
          ),
      );
  }
  const head = clone.querySelector("head");
  const policy = document.createElement("meta");
  policy.setAttribute("http-equiv", "Content-Security-Policy");
  policy.content = csp;
  const charset = document.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  const viewport = document.createElement("meta");
  viewport.name = "viewport";
  viewport.content = "width=device-width,initial-scale=1";
  const style = document.createElement("style");
  style.dataset.designBaseline = "true";
  style.textContent = css;
  head.prepend(policy, charset, viewport);
  head.append(style);
  return "<!doctype html>\n" + clone.outerHTML;
}

async function captureSnapshot(page, asset) {
  const resources = await page.evaluate(() => ({
    styles: [...document.querySelectorAll("link[rel~='stylesheet'],style")].map(
      (node) =>
        node.tagName === "LINK"
          ? { href: node.href }
          : { text: node.textContent },
    ),
    images: [...document.querySelectorAll("img[src]")].map(
      (image) => image.currentSrc || image.src,
    ),
    attributes: Object.fromEntries(
      [...document.documentElement.attributes].map(({ name, value }) => [
        name,
        value,
      ]),
    ),
  }));
  let css = "";
  for (const source of resources.styles) {
    const result = source.href
      ? (await asset(source.href)).bytes.toString("utf8")
      : source.text;
    css +=
      "\n" +
      (await inlinePublicCss(
        result ?? "",
        source.href ?? CAPTURE_ORIGIN,
        asset,
      ));
  }
  const imageMap = {};
  for (const reference of new Set(resources.images)) {
    const url = new URL(reference, CAPTURE_ORIGIN);
    if (!isPublicAsset(url)) continue;
    const result = await asset(url.href);
    if (!result.mime.startsWith("image/")) continue;
    imageMap[reference] =
      `data:${result.mime};base64,${result.bytes.toString("base64")}`;
  }
  const html = await page.evaluate(sanitizeDocument, {
    css,
    imageMap,
    csp: INERT_CSP,
  });
  check(Buffer.byteLength(html) <= VISUAL_LIMIT, "DESIGN_SNAPSHOT_TOO_LARGE");
  return { html, attributes: resources.attributes };
}

function sessionCookies(response) {
  const cookies = response.headers.getSetCookie().map((line) => {
    const [pair, ...attributes] = line.split(";");
    const separator = pair.indexOf("=");
    check(separator > 0, "DESIGN_SESSION_COOKIE_INVALID");
    return {
      name: pair.slice(0, separator),
      value: pair.slice(separator + 1),
      url: CAPTURE_ORIGIN,
      httpOnly: attributes.some(
        (attribute) => attribute.trim().toLowerCase() === "httponly",
      ),
      secure: true,
      sameSite: "Lax",
    };
  });
  check(cookies.length > 0 && cookies.length < 20, "DESIGN_SESSION_MISSING");
  return cookies;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv, "--capture", [
    "--origin",
    "--credentials",
    "--output",
    "--widths",
    "--browser",
  ]);
  check(
    args["--origin"] === CAPTURE_ORIGIN,
    "DESIGN_CANONICAL_PRODUCTION_ORIGIN_REQUIRED",
  );
  const widths = parseWidths(args["--widths"]);
  const channel = args["--browser"] ?? "chrome";
  check(["chrome", "chromium"].includes(channel), "DESIGN_BROWSER_INVALID");
  const output = await privateDirectory(args["--output"], {
    create: true,
    empty: true,
  });
  const credentials = JSON.parse(
    await readPrivateFile(args["--credentials"], 64 * 1024),
  );
  check(
    credentials.origin === CAPTURE_ORIGIN &&
      typeof credentials.email === "string" &&
      credentials.email &&
      typeof credentials.password === "string" &&
      credentials.password &&
      typeof credentials.user_id === "string" &&
      credentials.user_id &&
      typeof credentials.owner_id === "string" &&
      credentials.owner_id,
    "DESIGN_PRIVATE_OWNER_IDENTITY_REQUIRED",
  );
  await writeExclusivePrivateJson(
    join(output, "run-lock.json"),
    {
      format: "lifeos-design-capture-lock/1",
      started_at: new Date().toISOString(),
      business_writes_allowed: false,
    },
    { repositoryRoot: REPOSITORY },
  );
  const health = await fetch(CAPTURE_ORIGIN + "/api/health", {
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  check(
    health.ok && (await health.json()).status === "ok",
    "DESIGN_PRODUCTION_HEALTH_FAILED",
  );
  const signedIn = await boundedSignIn(CAPTURE_ORIGIN, credentials);
  check(signedIn.ok, "DESIGN_OWNER_SIGN_IN_FAILED");
  const cookies = sessionCookies(signedIn);
  const identityResponse = await fetch(
    CAPTURE_ORIGIN + "/api/v1/query?operation=whoami&input=%7B%7D",
    {
      redirect: "error",
      headers: {
        Cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
      },
      signal: AbortSignal.timeout(15000),
    },
  );
  const identity = (await identityResponse.json()).data;
  check(
    identityResponse.ok &&
      identity?.actor_id === credentials.user_id &&
      identity?.owner_id === credentials.owner_id,
    "DESIGN_OWNER_ACTOR_MISMATCH",
  );
  const browser = await chromium.launch({
    headless: true,
    ...(channel === "chrome" ? { channel } : {}),
  });
  const report = {
    format: "lifeos-private-design-capture/1",
    captured_at: new Date().toISOString(),
    origin: CAPTURE_ORIGIN,
    owner_actor_verified: true,
    business_writes_allowed: false,
    session_persisted: false,
    artifact_privacy: "PRIVATE_OWNER_DATA_OUTSIDE_GIT",
    evidence_kind: "READ_ONLY_LIVE_BASELINE_AND_INERT_DOM",
    note: "Automatic foreground write requests are blocked and may produce capture-only warning UI. Static replay is not functional proof.",
    blocked: { writes: 0, external: 0, other: 0 },
    captures: [],
  };
  try {
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: viewportFor(widths[0]),
      acceptDownloads: false,
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (requestAdmission(request.url(), request.method(), request.postData()))
        return route.continue();
      let sameOrigin = false;
      try {
        sameOrigin = new URL(request.url()).origin === CAPTURE_ORIGIN;
      } catch {
        /* fail closed */
      }
      report.blocked[
        !sameOrigin
          ? "external"
          : !["GET", "HEAD"].includes(request.method())
            ? "writes"
            : "other"
      ]++;
      if (sameOrigin && new URL(request.url()).pathname.startsWith("/api/")) {
        return route.fulfill({
          status: 403,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "VISUAL_CAPTURE_READ_ONLY",
              message:
                "Read-only visual capture blocked this operation; no data was changed.",
            },
          }),
        });
      }
      return route.abort("blockedbyclient");
    });
    await context.addCookies(cookies);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const asset = assetFetcher();
    for (const width of widths) {
      await page.setViewportSize(viewportFor(width));
      for (const [name, path] of DESIGN_ROUTES) {
        const blockedBefore = { ...report.blocked };
        let pageErrors = 0;
        const onError = () => pageErrors++;
        page.on("pageerror", onError);
        const response = await page.goto(CAPTURE_ORIGIN + path, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        check(
          response?.ok() &&
            new URL(page.url()).origin === CAPTURE_ORIGIN &&
            new URL(page.url()).pathname === path,
          "DESIGN_CAPTURE_ROUTE_NOT_AUTHENTICATED",
        );
        await page.locator("#workspace-main").waitFor({ state: "visible" });
        await page.locator("#workspace-main h1").waitFor({ state: "visible" });
        let settled = true;
        try {
          await page.waitForFunction(
            () => !document.querySelector("#workspace-main .loading-state"),
            null,
            { timeout: 15000 },
          );
        } catch {
          settled = false;
        }
        await page.evaluate(() =>
          Promise.race([
            document.fonts.ready,
            new Promise((resolve) => setTimeout(resolve, 2500)),
          ]),
        );
        const snapshot = await captureSnapshot(page, asset);
        const stem = `${name}-${width}`;
        await writePrivateBytes(join(output, stem + ".html"), snapshot.html);
        const screenshot = await page.screenshot({
          fullPage: true,
          animations: "disabled",
          timeout: 15000,
        });
        await writePrivateBytes(join(output, stem + ".png"), screenshot);
        const observation = await page.evaluate(() => ({
          alerts: document.querySelectorAll("#workspace-main [role='alert']")
            .length,
          page_overflow: document.documentElement.scrollWidth > innerWidth + 1,
        }));
        report.captures.push({
          name,
          path,
          viewport: viewportFor(width),
          html: stem + ".html",
          screenshot: stem + ".png",
          sha256: createHash("sha256").update(snapshot.html).digest("hex"),
          html_attributes: snapshot.attributes,
          loading_settled: settled,
          page_errors: pageErrors,
          ...observation,
          blocked: Object.fromEntries(
            Object.keys(report.blocked).map((key) => [
              key,
              report.blocked[key] - blockedBefore[key],
            ]),
          ),
        });
        page.off("pageerror", onError);
        console.log(
          JSON.stringify({
            status: "PRIVATE_BASELINE_CAPTURED",
            route: name,
            width,
            loading_settled: settled,
          }),
        );
      }
    }
    await context.close();
    await writeExclusivePrivateJson(join(output, "manifest.json"), report, {
      repositoryRoot: REPOSITORY,
    });
    console.log(
      JSON.stringify({
        status: "PRIVATE_READ_ONLY_BASELINE_COMPLETE",
        captures: report.captures.length,
        routes: DESIGN_ROUTES.length,
        business_writes_sent: 0,
      }),
    );
  } finally {
    await browser.close();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch(() => {
    console.error(
      "DESIGN_CAPTURE_FAILED; no credentials, owner identifiers or record contents emitted; private partial artifacts may remain.",
    );
    process.exitCode = 1;
  });
}
