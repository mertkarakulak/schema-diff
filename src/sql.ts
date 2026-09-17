/**
 * SQL generation: turn an ordered `Change[]` into `up.sql` / `down.sql` text.
 *
 * The `down` script is produced from `diffSnapshots(to, from)` (see diff.ts), so
 * every `createTable` / `addColumn` in the down direction is, by construction,
 * the reversal of a drop performed by `up`. Those are annotated with a
 * "data cannot be restored" note.
 */

import { diffSnapshots, isDestructive, type Change } from "./diff.js";
import type { Column, ForeignKey, PrimaryKey, Snapshot, Table, UniqueConstraint } from "./types.js";

export interface RenderContext {
  schema: string;
  /** When true, createTable/addColumn are reversals of a drop -> data-loss note. */
  annotateRecreation: boolean;
}

/** Quote an identifier. */
function q(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

/** Schema-qualified identifier. */
function qq(schema: string, name: string): string {
  return `${q(schema)}.${q(name)}`;
}

/** Quote a string literal. */
function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

function columnDef(col: Column): string {
  let out = `${q(col.name)} ${col.type}`;
  if (col.default !== null) out += ` DEFAULT ${col.default}`;
  if (!col.nullable) out += " NOT NULL";
  return out;
}

function pkClause(pk: PrimaryKey): string {
  return `CONSTRAINT ${q(pk.name)} PRIMARY KEY (${pk.columns.map(q).join(", ")})`;
}

function uniqueClause(u: UniqueConstraint): string {
  return `CONSTRAINT ${q(u.name)} UNIQUE (${u.columns.map(q).join(", ")})`;
}

function fkClause(fk: ForeignKey, schema: string): string {
  return (
    `CONSTRAINT ${q(fk.name)} FOREIGN KEY (${fk.columns.map(q).join(", ")}) ` +
    `REFERENCES ${qq(schema, fk.refTable)} (${fk.refColumns.map(q).join(", ")}) ` +
    `ON UPDATE ${fk.onUpdate} ON DELETE ${fk.onDelete}`
  );
}

function createTableSql(table: Table, ctx: RenderContext): string[] {
  const lines: string[] = [];
  if (ctx.annotateRecreation) {
    lines.push(
      `-- NOTE: data cannot be restored; this recreates a table the up migration dropped`,
    );
  }
  const inner: string[] = table.columns.map(columnDef);
  if (table.primaryKey) inner.push(pkClause(table.primaryKey));
  for (const u of table.uniques) inner.push(uniqueClause(u));
  lines.push(
    `CREATE TABLE ${qq(ctx.schema, table.name)} (\n  ${inner.join(",\n  ")}\n);`,
  );
  return lines;
}

function renderChange(change: Change, ctx: RenderContext): string[] {
  const s = ctx.schema;
  switch (change.kind) {
    case "createEnum":
      return [
        `CREATE TYPE ${qq(s, change.enum.name)} AS ENUM (${change.enum.values
          .map(lit)
          .join(", ")});`,
      ];
    case "dropEnum":
      return [
        `-- WARNING: destructive`,
        `DROP TYPE ${qq(s, change.enum.name)};`,
      ];
    case "addEnumValue": {
      const after = change.after ? ` AFTER ${lit(change.after)}` : "";
      return [
        `-- NOTE: ALTER TYPE ... ADD VALUE requires PostgreSQL 12+ to run inside a transaction`,
        `ALTER TYPE ${qq(s, change.enum)} ADD VALUE IF NOT EXISTS ${lit(change.value)}${after};`,
      ];
    }
    case "dropEnumValue":
      return [
        `-- WARNING: destructive; PostgreSQL cannot remove value ${lit(change.value)} from enum ${q(
          change.enum,
        )} (no SQL emitted)`,
      ];
    case "createTable":
      return createTableSql(change.table, ctx);
    case "dropTable":
      return [`-- WARNING: destructive`, `DROP TABLE ${qq(s, change.table.name)};`];
    case "addColumn": {
      const lines: string[] = [];
      if (ctx.annotateRecreation) {
        lines.push(
          `-- NOTE: data cannot be restored; this recreates a column the up migration dropped`,
        );
      }
      if (!change.column.nullable && change.column.default === null) {
        lines.push(
          `-- HAZARD: adding a NOT NULL column without a default fails on a non-empty table`,
        );
      }
      lines.push(
        `ALTER TABLE ${qq(s, change.table)} ADD COLUMN ${columnDef(change.column)};`,
      );
      return lines;
    }
    case "dropColumn":
      return [
        `-- WARNING: destructive`,
        `ALTER TABLE ${qq(s, change.table)} DROP COLUMN ${q(change.column.name)};`,
      ];
    case "alterColumnType": {
      const lines: string[] = [];
      if (change.destructive) {
        lines.push(
          `-- WARNING: destructive; type change ${change.from} -> ${change.to} may lose or fail to convert data`,
        );
      }
      lines.push(
        `ALTER TABLE ${qq(s, change.table)} ALTER COLUMN ${q(change.column)} TYPE ${change.to} USING ${q(
          change.column,
        )}::${change.to};`,
      );
      return lines;
    }
    case "alterColumnNullable":
      if (change.notNull) {
        return [
          `-- NOTE: SET NOT NULL fails if existing rows contain NULL in ${q(change.column)}`,
          `ALTER TABLE ${qq(s, change.table)} ALTER COLUMN ${q(change.column)} SET NOT NULL;`,
        ];
      }
      return [
        `ALTER TABLE ${qq(s, change.table)} ALTER COLUMN ${q(change.column)} DROP NOT NULL;`,
      ];
    case "alterColumnDefault":
      if (change.to === null) {
        return [
          `ALTER TABLE ${qq(s, change.table)} ALTER COLUMN ${q(change.column)} DROP DEFAULT;`,
        ];
      }
      return [
        `ALTER TABLE ${qq(s, change.table)} ALTER COLUMN ${q(change.column)} SET DEFAULT ${change.to};`,
      ];
    case "addPrimaryKey":
      return [
        `ALTER TABLE ${qq(s, change.table)} ADD ${pkClause(change.pk)};`,
      ];
    case "dropPrimaryKey":
      return [
        `ALTER TABLE ${qq(s, change.table)} DROP CONSTRAINT ${q(change.pk.name)};`,
      ];
    case "addUnique":
      return [
        `ALTER TABLE ${qq(s, change.table)} ADD ${uniqueClause(change.unique)};`,
      ];
    case "dropUnique":
      return [
        `ALTER TABLE ${qq(s, change.table)} DROP CONSTRAINT ${q(change.unique.name)};`,
      ];
    case "addForeignKey":
      return [
        `ALTER TABLE ${qq(s, change.table)} ADD ${fkClause(change.fk, s)};`,
      ];
    case "dropForeignKey":
      return [
        `ALTER TABLE ${qq(s, change.table)} DROP CONSTRAINT ${q(change.fk.name)};`,
      ];
    case "addIndex":
      // pg_indexes.indexdef is a complete, schema-qualified CREATE INDEX statement.
      return [`${change.index.definition.replace(/;?\s*$/, "")};`];
    case "dropIndex":
      return [`DROP INDEX ${qq(s, change.index.name)};`];
  }
}

function header(title: string, schema: string): string {
  return [
    `-- schema-diff ${title} migration`,
    `-- schema: ${schema}`,
    `-- generated: ${new Date().toISOString()}`,
  ].join("\n");
}

function renderScript(changes: Change[], ctx: RenderContext, title: string): string {
  const body =
    changes.length === 0
      ? "-- (no changes)"
      : changes.map((c) => renderChange(c, ctx).join("\n")).join("\n\n");
  return `${header(title, ctx.schema)}\n\nBEGIN;\n\n${body}\n\nCOMMIT;\n`;
}

export interface Migration {
  up: string;
  down: string;
  upChanges: Change[];
  downChanges: Change[];
  destructiveChanges: Change[];
  hasChanges: boolean;
}

export function generateMigration(from: Snapshot, to: Snapshot): Migration {
  const upChanges = diffSnapshots(from, to);
  const downChanges = diffSnapshots(to, from);

  const up = renderScript(
    upChanges,
    { schema: to.schema, annotateRecreation: false },
    "up",
  );
  const down = renderScript(
    downChanges,
    { schema: from.schema, annotateRecreation: true },
    "down",
  );

  const destructiveChanges = upChanges.filter(isDestructive);

  return {
    up,
    down,
    upChanges,
    downChanges,
    destructiveChanges,
    hasChanges: upChanges.length > 0,
  };
}
