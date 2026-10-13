import { readFile, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { prepareMigration, compareSnapshots } from "./core";

async function main() {
  const args = process.argv.slice(2);
  const source = args[0];
  if (
    !source ||
    !(args.includes("--dry-run") || args.includes("--staging-dry-run"))
  )
    throw new Error(
      "Usage: tsx scripts/migration/cli.ts <private-snapshot.json> --dry-run|--staging-dry-run [--previous <snapshot>] [--private-report <path>]",
    );
  const input = JSON.parse(await readFile(source, "utf8"));
  const prepared = prepareMigration(input);
  if (args.includes("--staging-dry-run")) {
    const { rehearseMigration } = await import("./staging");
    const result = await rehearseMigration(input);
    console.log(JSON.stringify(result));
    if (!result.pass) process.exitCode = 1;
    return;
  }
  const previous = args.indexOf("--previous");
  const delta =
    previous >= 0
      ? compareSnapshots(
          prepareMigration(
            JSON.parse(await readFile(args[previous + 1], "utf8")),
          ),
          prepared,
        )
      : null;
  const report = {
    ready: prepared.ready,
    source_hash: prepared.sourceHash,
    batch_id: prepared.batchId,
    counts: prepared.counts,
    quarantine: prepared.quarantine,
    delta,
    dependencies_created: 0,
    checklists_created: 0,
    destination_written: false,
    source_written: false,
  };
  const reportIndex = args.indexOf("--private-report");
  if (reportIndex >= 0) {
    const output = resolve(args[reportIndex + 1]);
    const repository = resolve(process.cwd());
    const deltaPath = relative(repository, output);
    if (!(
      isAbsolute(deltaPath) ||
      deltaPath === ".." ||
      deltaPath.startsWith(".." + sep)
    ))
      throw new Error(
        "Private migration reports must be outside the repository.",
      );
    await writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  console.log(
    JSON.stringify({
      ready: prepared.ready,
      counts: prepared.counts,
      quarantined: prepared.quarantine.length,
      delta_detected: delta ? !delta.unchanged : null,
      source_written: false,
      destination_written: false,
    }),
  );
  if (!prepared.ready) process.exitCode = 1;
}
main().catch((error) => {
  const category = error instanceof Error ? error.name : "UnknownError";
  console.error(
    "Migration dry-run failed (" +
      category +
      "). Check the private source path and source schema.",
  );
  process.exitCode = 1;
});
