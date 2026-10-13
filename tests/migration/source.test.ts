import { describe, expect, it } from "vitest";
import {
  compareSnapshots,
  migrationCommandInput,
  prepareMigration,
  sourceDate,
} from "../../scripts/migration/core";
import { syntheticSnapshot } from "./fixtures";
describe("legacy source preservation", () => {
  it("hash and stable batch ignore spreadsheet row order and blank template rows", () => {
    const source = syntheticSnapshot(),
      reordered = structuredClone(source);
    reordered.tables.Tasks.reverse();
    reordered.tables.Tasks.push({});
    expect(prepareMigration(source).sourceHash).toBe(
      prepareMigration(reordered).sourceHash,
    );
    expect(prepareMigration(source).counts.Tasks).toBe(2);
  });
  it("preserves literal Persian notes and no-date semantics without invented graph records", () => {
    const source = syntheticSnapshot(),
      prepared = prepareMigration(source),
      command = migrationCommandInput(prepared);
    expect(prepared.tables.Tasks[0]).toEqual(source.tables.Tasks[0]);
    expect(prepared.tables.Tasks[0].notes).toBe("=SUM(1,2)");
    expect(prepared.tables.Tasks[0].due_date).toBe("");
    expect(command).not.toHaveProperty("dependencies");
    expect(command).not.toHaveProperty("checklists");
    expect(command.guide).toEqual(source.tables.Guide);
    expect(command.settings).toEqual(source.tables.Settings);
  });
  it("converts verified DATE serial to local date and rejects ambiguous US display text", () => {
    expect(sourceDate(25569)).toBe("1970-01-01");
    expect(sourceDate("")).toBeNull();
    expect(sourceDate("2026-03-29")).toBe("2026-03-29");
    expect(() => sourceDate("11/17/2026")).toThrow();
    expect(() => sourceDate("2026-02-30")).toThrow();
  });
  it("quarantines orphan links and duplicate immutable IDs without committing partial records", () => {
    const source = syntheticSnapshot();
    source.tables.Links[0].task_id = "missing-task";
    source.tables.Tasks.push({ ...source.tables.Tasks[0] });
    const prepared = prepareMigration(source);
    expect(prepared.ready).toBe(false);
    expect(prepared.quarantine).toHaveLength(3);
    expect(() => migrationCommandInput(prepared)).toThrow(/quarantined/);
    expect(prepared.tables.Tasks).toHaveLength(3);
  });
  it("rejects timestamp without explicit offset and nonliteral link boolean", () => {
    const source = syntheticSnapshot();
    source.tables.Tasks[0].updated_at = "2026-10-10T12:00:00";
    source.tables.Links[0].active = "TRUE";
    const prepared = prepareMigration(source);
    expect(prepared.ready).toBe(false);
    expect(prepared.quarantine.flatMap((q) => q.reasons)).toContain(
      "invalid_link_boolean",
    );
  });
  it("preserves external file semantics and permits different relation types for same task/file", () => {
    const source = syntheticSnapshot();
    source.tables.Links.push({
      ...source.tables.Links[0],
      link_id: "L-synthetic-two",
      relation: "Input",
    });
    expect(prepareMigration(source).ready).toBe(true);
    source.tables.Links[1].relation = "Reference";
    expect(prepareMigration(source).ready).toBe(false);
  });
  it("detects added changed and missing IDs without inferring a source deletion", () => {
    const source = syntheticSnapshot(),
      next = structuredClone(source);
    next.tables.Tasks[0].title = "Changed";
    next.tables.Tasks.pop();
    next.tables.Tasks.push({
      ...next.tables.Tasks[0],
      task_id: "T-synthetic-three",
    });
    const delta = compareSnapshots(
      prepareMigration(source),
      prepareMigration(next),
    );
    expect(delta.unchanged).toBe(false);
    expect(delta.delete_source_records).toBe(false);
    expect(delta.delta.Tasks).toEqual({
      added: ["T-synthetic-three"],
      changed: ["T-synthetic-one"],
      missing: ["T-synthetic-two"],
    });
  });
});
