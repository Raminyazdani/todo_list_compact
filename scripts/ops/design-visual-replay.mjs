/** Inert visual specimens only: never an authenticated or functional app test. */
import { chromium } from "@playwright/test";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeExclusivePrivateJson } from "./private-paths.mjs";
import {
  DESIGN_ROUTES,
  INERT_CSP,
  REPOSITORY,
  VISUAL_LIMIT,
  isInside,
  parseArguments,
  parseWidths,
  privateDirectory,
  readPrivateFile,
  replaceAsync,
  viewportFor,
  writePrivateBytes,
} from "./design-visual-capture.mjs";

const assetTypes = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

function check(condition, code) {
  if (!condition) throw new Error(code);
}

async function sourceFile(candidate, extensions) {
  check(
    typeof candidate === "string" && isAbsolute(candidate),
    "DESIGN_CANDIDATE_ABSOLUTE_PATH_REQUIRED",
  );
  const lexical = resolve(candidate);
  const canonical = await realpath(lexical);
  const repository = await realpath(REPOSITORY);
  const stat = await lstat(lexical);
  check(
    isInside(repository, canonical) &&
      lexical.toLowerCase() === canonical.toLowerCase() &&
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      stat.size <= VISUAL_LIMIT &&
      extensions.includes(extname(canonical).toLowerCase()),
    "DESIGN_ONLY_REGULAR_REPOSITORY_STYLE_ASSETS_ALLOWED",
  );
  return canonical;
}

/** Resolve only local CSS/image/font sources, never arbitrary files or URLs. */
export async function bundleCandidateCss(candidate, visited = new Set()) {
  const source = await sourceFile(candidate, [".css"]);
  check(
    !visited.has(source) && visited.size < 20,
    "DESIGN_CSS_IMPORT_CYCLE_OR_LIMIT",
  );
  const stack = new Set(visited).add(source);
  let text = await readFile(source, "utf8");
  const directory = resolve(source, "..");
  text = await replaceAsync(
    text,
    /@import\s+(?:url\(\s*["']?([^"'\s)]+)["']?\s*\)|["']([^"']+)["'])\s*([^;]*);/gi,
    async (match) => {
      const reference = match[1] ?? match[2];
      check(
        !/^(?:[a-z]+:|\/\/|\/)/i.test(reference),
        "DESIGN_REMOTE_CSS_IMPORT_REJECTED",
      );
      const imported = await bundleCandidateCss(
        resolve(directory, reference),
        stack,
      );
      const condition = match[3].trim();
      check(
        !/^(?:layer|supports)\b/i.test(condition),
        "DESIGN_COMPLEX_CSS_IMPORT_UNSUPPORTED",
      );
      return condition ? `@media ${condition}{\n${imported}\n}` : imported;
    },
  );
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
      check(
        !/^(?:[a-z]+:|\/\/)/i.test(reference),
        "DESIGN_REMOTE_STYLE_ASSET_REJECTED",
      );
      const clean = reference.split(/[?#]/)[0];
      const candidatePath = clean.startsWith("/")
        ? join(REPOSITORY, "public", clean.slice(1))
        : resolve(directory, clean);
      const asset = await sourceFile(candidatePath, Object.keys(assetTypes));
      const bytes = await readFile(asset);
      check(bytes.length <= 4 * 1024 * 1024, "DESIGN_STYLE_ASSET_TOO_LARGE");
      return `url("data:${assetTypes[extname(asset).toLowerCase()]};base64,${bytes.toString("base64")}")`;
    },
  );
}

/** Defense in depth for private input HTML; JS is also disabled by the browser. */
export function prepareReplay({ html, css, theme, direction, csp }) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  for (const node of parsed.querySelectorAll(
    "script,noscript,iframe,frame,frameset,object,embed,base,link,meta,foreignObject,template,animate,animateMotion,animateTransform,set,audio,video,source,track",
  ))
    node.remove();
  for (const node of parsed.querySelectorAll("*")) {
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
    if (
      node.hasAttribute("src") &&
      !/^data:image\//i.test(node.getAttribute("src"))
    )
      node.removeAttribute("src");
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
  parsed.documentElement.dataset.theme = theme;
  parsed.documentElement.dataset.reduceMotion = "true";
  parsed.documentElement.dir = direction;
  parsed.documentElement.dataset.designReplay = "static";
  const policy = parsed.createElement("meta");
  policy.setAttribute("http-equiv", "Content-Security-Policy");
  policy.content = csp;
  const charset = parsed.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  const viewport = parsed.createElement("meta");
  viewport.name = "viewport";
  viewport.content = "width=device-width,initial-scale=1";
  parsed.head.prepend(policy, charset, viewport);
  if (css) {
    const style = parsed.createElement("style");
    style.dataset.designCandidate = "true";
    style.textContent = css;
    parsed.head.append(style);
  }
  return "<!doctype html>\n" + parsed.documentElement.outerHTML;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv, "--replay", [
    "--input",
    "--output",
    "--css",
    "--widths",
    "--themes",
    "--directions",
    "--browser",
  ]);
  const input = await privateDirectory(args["--input"]);
  const output = await privateDirectory(args["--output"], {
    create: true,
    empty: true,
  });
  check(
    !isInside(input, output) && !isInside(output, input),
    "DESIGN_INPUT_OUTPUT_MUST_BE_SEPARATE",
  );
  const manifest = JSON.parse(
    await readPrivateFile(join(input, "manifest.json")),
  );
  check(
    manifest.format === "lifeos-private-design-capture/1" &&
      manifest.owner_actor_verified === true &&
      Array.isArray(manifest.captures),
    "DESIGN_CAPTURE_MANIFEST_INVALID",
  );
  check(
    DESIGN_ROUTES.every(([name, path]) =>
      manifest.captures.some(
        (capture) => capture.name === name && capture.path === path,
      ),
    ),
    "DESIGN_CAPTURE_MUST_INCLUDE_ALL_TEN_ROUTES",
  );
  const widths = parseWidths(args["--widths"]);
  const themes = (args["--themes"] ?? "dark,light").split(",");
  const directions = (args["--directions"] ?? "rtl").split(",");
  check(
    themes.length >= 1 &&
      themes.length <= 2 &&
      new Set(themes).size === themes.length &&
      themes.every((theme) => ["dark", "light"].includes(theme)),
    "DESIGN_THEMES_INVALID",
  );
  check(
    directions.length >= 1 &&
      directions.length <= 2 &&
      new Set(directions).size === directions.length &&
      directions.every((direction) => ["rtl", "ltr"].includes(direction)),
    "DESIGN_DIRECTIONS_INVALID",
  );
  const css = args["--css"] ? await bundleCandidateCss(args["--css"]) : "";
  check(
    Buffer.byteLength(css) <= VISUAL_LIMIT,
    "DESIGN_CANDIDATE_STYLES_TOO_LARGE",
  );
  const channel = args["--browser"] ?? "chrome";
  check(["chrome", "chromium"].includes(channel), "DESIGN_BROWSER_INVALID");
  const report = {
    format: "lifeos-private-design-replay/1",
    evidence_kind: "STATIC_VISUAL_ONLY_NOT_FUNCTIONAL_PROOF",
    replayed_at: new Date().toISOString(),
    javascript_enabled: false,
    credentials_loaded: false,
    network_allowed: false,
    reduced_motion: true,
    changes_persisted_to_application: false,
    translations_exercised: false,
    note: "Theme/direction/viewport changes affect inert DOM only. Text stays in the captured language. CSS is appended to captured public stylesheet rules. Hydration, focus, interactions, mutations and saved preferences require real synthetic E2E tests.",
    css_sha256: createHash("sha256").update(css).digest("hex"),
    attempts_blocked: 0,
    captures: [],
  };
  await writeExclusivePrivateJson(
    join(output, "run-lock.json"),
    { evidence_kind: report.evidence_kind, started_at: report.replayed_at },
    { repositoryRoot: REPOSITORY },
  );
  const browser = await chromium.launch({
    headless: true,
    ...(channel === "chrome" ? { channel } : {}),
  });
  try {
    const context = await browser.newContext({
      javaScriptEnabled: false,
      serviceWorkers: "block",
      acceptDownloads: false,
      reducedMotion: "reduce",
    });
    await context.route("**/*", (route) => {
      report.attempts_blocked++;
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    for (const [name, path] of DESIGN_ROUTES) {
      for (const width of widths) {
        const captures = manifest.captures.filter(
          (capture) => capture.name === name && capture.path === path,
        );
        const source =
          captures.find((capture) => capture.viewport?.width === width) ??
          captures[0];
        check(
          typeof source.html === "string" &&
            /^[a-z]+-(?:390|768|1440)\.html$/.test(source.html),
          "DESIGN_SNAPSHOT_FILENAME_INVALID",
        );
        const html = await readPrivateFile(join(input, source.html));
        check(
          createHash("sha256").update(html).digest("hex") === source.sha256,
          "DESIGN_SNAPSHOT_HASH_MISMATCH",
        );
        for (const theme of themes) {
          for (const direction of directions) {
            await page.setViewportSize(viewportFor(width));
            const rendered = await page.evaluate(prepareReplay, {
              html,
              css,
              theme,
              direction,
              csp: INERT_CSP,
            });
            await page.setContent(rendered, {
              waitUntil: "load",
              timeout: 15000,
            });
            await page.evaluate(() => document.fonts.ready);
            const stem = `${name}-${width}-${theme}-${direction}`;
            const screenshot = await page.screenshot({
              fullPage: true,
              animations: "disabled",
              timeout: 15000,
            });
            await writePrivateBytes(join(output, stem + ".png"), screenshot);
            const geometry = await page.evaluate(() => ({
              page_overflow:
                document.documentElement.scrollWidth > innerWidth + 1,
              document_height: document.documentElement.scrollHeight,
              main_visible: Boolean(document.querySelector("#workspace-main")),
              scripts: document.scripts.length,
              active_frames: document.querySelectorAll(
                "iframe,frame,object,embed",
              ).length,
            }));
            check(
              geometry.scripts === 0 && geometry.active_frames === 0,
              "DESIGN_REPLAY_NOT_INERT",
            );
            report.captures.push({
              name,
              path,
              width,
              theme,
              direction,
              screenshot: stem + ".png",
              captured_width: source.viewport.width,
              derived_viewport: source.viewport.width !== width,
              ...geometry,
            });
          }
        }
      }
      console.log(
        JSON.stringify({
          status: "STATIC_PRIVATE_ROUTE_REPLAYED",
          route: name,
        }),
      );
    }
    await context.close();
    await writeExclusivePrivateJson(join(output, "manifest.json"), report, {
      repositoryRoot: REPOSITORY,
    });
    console.log(
      JSON.stringify({
        status: "STATIC_VISUAL_ONLY_COMPLETE",
        captures: report.captures.length,
        functional_test_claimed: false,
        network_allowed: false,
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
      "DESIGN_REPLAY_FAILED; no private snapshot contents emitted; static visual evidence is not functional proof.",
    );
    process.exitCode = 1;
  });
}
