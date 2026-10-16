import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .split(/\r?\n/)
  .filter(Boolean);
const forbiddenFiles =
  /(?:PRIVATE_SOURCE|REFERENCE_(?:LEDGER|HUB)|migration-input|credentials-.+-private|\.env(?:\.|$)|live-source|\.xlsx$|\.zip$|backup.+\.json$)/i;
const forbiddenSecrets =
  /(?:gh[opusr]_[A-Za-z0-9]{25,}|AIza[A-Za-z0-9_-]{30,}|GOCSPX-[A-Za-z0-9_-]{20,}|sk-(?:proj-)?[A-Za-z0-9_-]{30,}|postgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@(?!localhost|127\.0\.0\.1))/;
let privateIds: string[] = [];
const sourceIndex = process.argv.indexOf("--private-source");
if (sourceIndex >= 0) {
  const parsed = JSON.parse(
    readFileSync(process.argv[sourceIndex + 1], "utf8"),
  );
  const collect = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object")
      for (const [key, item] of Object.entries(value)) {
        if (
          (key === "id" || key.endsWith("_id")) &&
          typeof item === "string" &&
          item.length > 10
        )
          privateIds.push(item);
        else collect(item);
      }
  };
  collect(parsed);
  privateIds = [...new Set(privateIds)];
}
const failures: { path: string; reason: string }[] = [];
for (const path of files) {
  if (path === ".env.example") continue;
  if (forbiddenFiles.test(path)) {
    failures.push({ path, reason: "private_or_binary_source_file" });
    continue;
  }
  let content: string;
  try {
    content = readFileSync(resolve(path), "utf8");
  } catch {
    continue;
  }
  if (forbiddenSecrets.test(content))
    failures.push({ path, reason: "credential_pattern" });
  if (privateIds.some((id) => content.includes(id)))
    failures.push({ path, reason: "private_source_identifier" });
}
console.log(
  JSON.stringify(
    {
      files_checked: files.length,
      private_identifiers_checked: privateIds.length,
      failures,
    },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
