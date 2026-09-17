import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateMigration } from "../src/sql.js";
import type { Snapshot } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
function fixture(name: string): Snapshot {
  return JSON.parse(readFileSync(join(here, "fixtures", `${name}.json`), "utf8")) as Snapshot;
}

const base = fixture("base");
const target = fixture("target");

describe("generateMigration - structure", () => {
  const m = generateMigration(base, target);

  it("wraps both scripts in a transaction", () => {
    expect(m.up).toContain("BEGIN;");
    expect(m.up.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(m.down).toContain("BEGIN;");
    expect(m.down.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("reports it has changes and lists destructive ones", () => {
    expect(m.hasChanges).toBe(true);
    expect(m.destructiveChanges.length).toBeGreaterThan(0);
  });
});

describe("generateMigration - up.sql content", () => {
  const { up } = generateMigration(base, target);

  it("creates new tables and enums with schema qualification", () => {
    expect(up).toContain('CREATE TABLE "public"."comments"');
    expect(up).toContain('CREATE TYPE "public"."role" AS ENUM (\'admin\', \'member\')');
  });

  it("emits column, constraint and index statements", () => {
    expect(up).toContain('ALTER TABLE "public"."users" ADD COLUMN "bio" text');
    expect(up).toMatch(/ALTER TABLE "public"\."comments" ADD CONSTRAINT "comments_post_id_fkey" FOREIGN KEY/);
    expect(up).toContain("CREATE INDEX users_email_lower_idx");
  });

  it("adds enum values with position and IF NOT EXISTS", () => {
    expect(up).toContain("ALTER TYPE \"public\".\"status\" ADD VALUE IF NOT EXISTS 'archived' AFTER 'inactive'");
  });

  it("flags destructive changes with a warning comment", () => {
    expect(up).toContain("-- WARNING: destructive");
    expect(up).toContain('DROP TABLE "public"."legacy_audit";');
    expect(up).toContain('DROP COLUMN "legacy_notes";');
  });

  it("uses USING clause on type changes", () => {
    expect(up).toMatch(/ALTER COLUMN "title" TYPE character varying\(200\) USING "title"::character varying\(200\)/);
  });
});

describe("generateMigration - down.sql reversibility notes", () => {
  const { down } = generateMigration(base, target);

  it("recreates dropped tables/columns with a data-loss note", () => {
    expect(down).toContain("-- NOTE: data cannot be restored");
    expect(down).toContain('CREATE TABLE "public"."legacy_audit"');
    expect(down).toContain('ADD COLUMN "legacy_notes"');
  });

  it("reverses index and enum-value operations honestly", () => {
    // status gained 'archived' in up; down cannot remove it -> warning only.
    expect(down).toContain("cannot remove value 'archived'");
  });
});

describe("generateMigration - hazard comments", () => {
  it("warns when adding a NOT NULL column without a default to an existing table", () => {
    const from: Snapshot = {
      version: 1,
      schema: "public",
      enums: [],
      tables: [
        { name: "t", columns: [{ name: "id", type: "integer", nullable: false, default: null }], primaryKey: null, uniques: [], foreignKeys: [], indexes: [] },
      ],
    };
    const to: Snapshot = {
      version: 1,
      schema: "public",
      enums: [],
      tables: [
        {
          name: "t",
          columns: [
            { name: "id", type: "integer", nullable: false, default: null },
            { name: "code", type: "text", nullable: false, default: null },
          ],
          primaryKey: null,
          uniques: [],
          foreignKeys: [],
          indexes: [],
        },
      ],
    };
    const { up } = generateMigration(from, to);
    expect(up).toContain("-- HAZARD: adding a NOT NULL column without a default");
  });

  it("notes that SET NOT NULL can fail on existing NULLs", () => {
    const from: Snapshot = {
      version: 1,
      schema: "public",
      enums: [],
      tables: [
        { name: "t", columns: [{ name: "c", type: "text", nullable: true, default: null }], primaryKey: null, uniques: [], foreignKeys: [], indexes: [] },
      ],
    };
    const to: Snapshot = {
      version: 1,
      schema: "public",
      enums: [],
      tables: [
        { name: "t", columns: [{ name: "c", type: "text", nullable: false, default: null }], primaryKey: null, uniques: [], foreignKeys: [], indexes: [] },
      ],
    };
    const { up } = generateMigration(from, to);
    expect(up).toContain("SET NOT NULL fails if existing rows contain NULL");
    expect(up).toContain('ALTER COLUMN "c" SET NOT NULL;');
  });
});

describe("generateMigration - empty diff", () => {
  it("produces no-op scripts", () => {
    const m = generateMigration(base, base);
    expect(m.hasChanges).toBe(false);
    expect(m.up).toContain("-- (no changes)");
  });
});
