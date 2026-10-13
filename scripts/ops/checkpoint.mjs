import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const path = "docs/BUILD_PROGRESS.json";
const progress = JSON.parse(await readFile(path, "utf8"));
const phase = process.argv[2] ?? progress.phase;
progress.updated_at = new Date().toISOString();
progress.branch = execFileSync("git", ["branch", "--show-current"], {
  encoding: "utf8",
}).trim();
progress.commit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
progress.phase = phase;
await writeFile(path, JSON.stringify(progress, null, 2) + "\n");
console.log(
  JSON.stringify({
    phase,
    branch: progress.branch,
    commit: progress.commit,
    release_complete: progress.release_complete,
  }),
);
