import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffSnapshots, isDestructive, isSafeWiden, sortChanges, type Change } from "../src/diff.js";
import type { Snapshot } from "../src/types.js";
import { applyChanges, normalize } from "./apply.js";

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): Snapshot {
  return JSON.parse(readFileSync(join(here, "fixtures", `${name}.json`), "utf8")) as Snapshot;
}

const base = fixture("base");
const target = fixture("target");

const empty: Snapshot = { version: 1, schema: "public", tables: [], enums: [] };

describe("diffSnapshots - completeness (property)", () => {
  it("applying up transforms base into target", () => {
    const up = diffSnapshots(base, target);
    const result = applyChanges(base, up);
    expect(normalize(result)).toEqual(normalize(target));
  });

  it("applying down (reverse diff) transforms target back into base", () => {
    const down = diffSnapshots(target, base);
    const result = applyChanges(target, down);
    expect(normalize(result)).toEqual(normalize(base));
  });

  it("up then down returns to the original schema", () => {
    const up = diffSnapshots(base, target);
    const down = diffSnapshots(target, base);
    const forward = applyChanges(base, up);
    const backAgain = applyChanges(forward, down);
    expect(normalize(backAgain)).toEqual(normalize(base));
  });

  it("creating a whole schema from empty round-trips", () => {
    const up = diffSnapshots(empty, target);
    expect(normalize(applyChanges(empty, up))).toEqual(normalize(target));
    const down = diffSnapshots(target, empty);
    expect(normalize(applyChanges(target, down))).toEqual(normalize(empty));
  });
});

describe("diffSnapshots - no-op", () => {
  it("returns empty for identical snapshots", () => {
    expect(diffSnapshots(base, base)).toEqual([]);
    expect(diffSnapshots(target, target)).toEqual([]);
  });
});

describe("diffSnapshots - detected changes", () => {
  const up = diffSnapshots(base, target);
  const kinds = up.map((c) => c.kind);

  it("detects created and dropped tables", () => {
    expect(up).toContainEqual(expect.objectContaining({ kind: "createTable", table: expect.objectContaining({ name: "comments" }) }));
    expect(up).toContainEqual(expect.objectContaining({ kind: "dropTable", table: expect.objectContaining({ name: "legacy_audit" }) }));
  });

  it("detects added and dropped columns", () => {
    expect(up).toContainEqual(expect.objectContaining({ kind: "addColumn", table: "users", column: expect.objectContaining({ name: "bio" }) }));
    expect(up).toContainEqual(expect.objectContaining({ kind: "dropColumn", table: "users", column: expect.objectContaining({ name: "legacy_notes" }) }));
  });

  it("classifies widening as safe and narrowing as destructive", () => {
    const emailType = up.find(
      (c): c is Extract<Change, { kind: "alterColumnType" }> =>
        c.kind === "alterColumnType" && c.table === "users" && c.column === "email",
    );
    expect(emailType?.destructive).toBe(false); // varchar(100) -> varchar(255)

    const titleType = up.find(
      (c): c is Extract<Change, { kind: "alterColumnType" }> =>
        c.kind === "alterColumnType" && c.table === "posts" && c.column === "title",
    );
    expect(titleType?.destructive).toBe(true); // text -> varchar(200)
  });

  it("detects enum creation and value additions", () => {
    expect(up).toContainEqual(expect.objectContaining({ kind: "createEnum", enum: expect.objectContaining({ name: "role" }) }));
    expect(up).toContainEqual(expect.objectContaining({ kind: "addEnumValue", enum: "status", value: "archived", after: "inactive" }));
  });

  it("detects index add and drop", () => {
    expect(kinds).toContain("addIndex");
    expect(kinds).toContain("dropIndex");
  });
});

describe("diffSnapshots - deterministic ordering", () => {
  const up = diffSnapshots(base, target);
  const orderOf = (kind: Change["kind"]) => up.findIndex((c) => c.kind === kind);

  it("drops before creates", () => {
    expect(orderOf("dropTable")).toBeLessThan(orderOf("createTable"));
    expect(orderOf("dropColumn")).toBeLessThan(orderOf("addColumn"));
  });

  it("creates enums before the tables/columns that use them", () => {
    expect(orderOf("createEnum")).toBeLessThan(orderOf("addColumn"));
    expect(orderOf("createEnum")).toBeLessThan(orderOf("createTable"));
  });

  it("adds foreign keys last, after tables and columns exist", () => {
    const fkIdx = orderOf("addForeignKey");
    expect(fkIdx).toBeGreaterThan(orderOf("createTable"));
    expect(fkIdx).toBeGreaterThan(orderOf("addColumn"));
  });

  it("is stable: sorting twice is a fixed point", () => {
    expect(sortChanges(up)).toEqual(up);
  });

  it("is byte-for-byte reproducible across runs", () => {
    expect(diffSnapshots(base, target)).toEqual(diffSnapshots(base, target));
  });
});

describe("isDestructive", () => {
  it("flags drops and narrowing", () => {
    const up = diffSnapshots(base, target);
    const destructive = up.filter(isDestructive).map((c) => c.kind);
    expect(destructive).toContain("dropTable");
    expect(destructive).toContain("dropColumn");
    expect(destructive).toContain("alterColumnType"); // posts.title narrowing
  });
});

describe("isSafeWiden", () => {
  it("recognizes safe widenings", () => {
    expect(isSafeWiden("smallint", "integer")).toBe(true);
    expect(isSafeWiden("integer", "bigint")).toBe(true);
    expect(isSafeWiden("character varying(100)", "character varying(255)")).toBe(true);
    expect(isSafeWiden("character varying(100)", "text")).toBe(true);
    expect(isSafeWiden("numeric(10,2)", "numeric(12,4)")).toBe(true);
    expect(isSafeWiden("integer", "integer")).toBe(true);
  });

  it("recognizes destructive narrowings", () => {
    expect(isSafeWiden("bigint", "integer")).toBe(false);
    expect(isSafeWiden("text", "character varying(200)")).toBe(false);
    expect(isSafeWiden("character varying(255)", "character varying(100)")).toBe(false);
    expect(isSafeWiden("integer", "text")).toBe(false);
    expect(isSafeWiden("numeric(12,4)", "numeric(10,2)")).toBe(false);
  });
});
