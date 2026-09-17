/**
 * Pure diff engine.
 *
 * `diffSnapshots(from, to)` returns an ordered list of `Change` objects that
 * transform `from` into `to`. The `down` migration is produced simply by calling
 * `diffSnapshots(to, from)` -- the same function, the same ordering guarantees,
 * no inversion logic. This is why reversibility holds: the hard part (ordering
 * drops before creates, FKs after tables, enums before their consumers) is solved
 * once and reused in both directions.
 */

import type {
  Column,
  EnumType,
  ForeignKey,
  Index,
  PrimaryKey,
  Snapshot,
  Table,
  UniqueConstraint,
} from "./types.js";

export type Change =
  | { kind: "createEnum"; enum: EnumType }
  | { kind: "dropEnum"; enum: EnumType }
  | { kind: "addEnumValue"; enum: string; value: string; after: string | null }
  | { kind: "dropEnumValue"; enum: string; value: string }
  | { kind: "createTable"; table: Table }
  | { kind: "dropTable"; table: Table }
  | { kind: "addColumn"; table: string; column: Column }
  | { kind: "dropColumn"; table: string; column: Column }
  | {
      kind: "alterColumnType";
      table: string;
      column: string;
      from: string;
      to: string;
      destructive: boolean;
    }
  | {
      kind: "alterColumnNullable";
      table: string;
      column: string;
      /** true => SET NOT NULL, false => DROP NOT NULL */
      notNull: boolean;
    }
  | {
      kind: "alterColumnDefault";
      table: string;
      column: string;
      from: string | null;
      to: string | null;
    }
  | { kind: "addPrimaryKey"; table: string; pk: PrimaryKey }
  | { kind: "dropPrimaryKey"; table: string; pk: PrimaryKey }
  | { kind: "addUnique"; table: string; unique: UniqueConstraint }
  | { kind: "dropUnique"; table: string; unique: UniqueConstraint }
  | { kind: "addForeignKey"; table: string; fk: ForeignKey }
  | { kind: "dropForeignKey"; table: string; fk: ForeignKey }
  | { kind: "addIndex"; table: string; index: Index }
  | { kind: "dropIndex"; table: string; index: Index };

/**
 * Canonical execution order. Lower number runs first. This ordering is the
 * contract that makes migrations safe to apply and to reverse:
 *  - all drops (FK -> index -> unique -> pk -> table -> column) before any create
 *  - enums created before the tables/columns that consume them, dropped after
 *  - new tables/columns before the constraints and indexes that reference them
 *  - foreign keys added last, after every referenced table exists
 */
const ORDER: Record<Change["kind"], number> = {
  dropForeignKey: 0,
  dropIndex: 1,
  dropUnique: 2,
  dropPrimaryKey: 3,
  dropTable: 4,
  dropColumn: 5,
  dropEnumValue: 6,
  dropEnum: 7,
  createEnum: 8,
  addEnumValue: 9,
  alterColumnType: 10,
  alterColumnDefault: 11,
  alterColumnNullable: 12,
  createTable: 13,
  addColumn: 14,
  addPrimaryKey: 15,
  addUnique: 16,
  addIndex: 17,
  addForeignKey: 18,
};

/** Stable secondary sort key so output is byte-for-byte deterministic. */
function secondaryKey(c: Change): string {
  switch (c.kind) {
    case "createEnum":
    case "dropEnum":
      return c.enum.name;
    case "addEnumValue":
    case "dropEnumValue":
      return `${c.enum}.${c.value}`;
    case "createTable":
    case "dropTable":
      return c.table.name;
    case "addColumn":
    case "dropColumn":
      return `${c.table}.${c.column.name}`;
    case "alterColumnType":
    case "alterColumnNullable":
    case "alterColumnDefault":
      return `${c.table}.${c.column}`;
    case "addPrimaryKey":
    case "dropPrimaryKey":
      return `${c.table}.${c.pk.name}`;
    case "addUnique":
    case "dropUnique":
      return `${c.table}.${c.unique.name}`;
    case "addForeignKey":
    case "dropForeignKey":
      return `${c.table}.${c.fk.name}`;
    case "addIndex":
    case "dropIndex":
      return `${c.table}.${c.index.name}`;
  }
}

function byName<T extends { name: string }>(items: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const it of items) m.set(it.name, it);
  return m;
}

/**
 * Known-safe widening type changes. Anything not covered here is treated as
 * destructive (conservative and honest -- a false "destructive" flag is a
 * warning the user can override; a false "safe" flag corrupts data silently).
 */
export function isSafeWiden(from: string, to: string): boolean {
  const f = from.toLowerCase().trim();
  const t = to.toLowerCase().trim();
  if (f === t) return true;

  const widenChains: string[][] = [
    ["smallint", "integer", "bigint"],
    ["real", "double precision"],
  ];
  for (const chain of widenChains) {
    const fi = chain.indexOf(f);
    const ti = chain.indexOf(t);
    if (fi !== -1 && ti !== -1 && ti >= fi) return true;
  }

  // varchar(n) -> text, or char/varchar length increase, is non-destructive.
  const varchar = /^(character varying|varchar)\((\d+)\)$/;
  const fm = f.match(varchar);
  const tm = t.match(varchar);
  if (fm && (t === "text")) return true;
  if (fm && tm && Number(tm[2]) >= Number(fm[2])) return true;
  if ((f === "character varying" || f === "varchar") && t === "text") return true;

  // numeric/decimal precision or scale increase.
  const numeric = /^(numeric|decimal)\((\d+),(\d+)\)$/;
  const fn = f.match(numeric);
  const tn = t.match(numeric);
  if (fn && tn) {
    const [, , fp, fs] = fn;
    const [, , tp, ts] = tn;
    if (Number(tp) >= Number(fp) && Number(ts) >= Number(fs)) return true;
  }
  if (fn && (t === "numeric" || t === "decimal")) return true; // -> unconstrained numeric

  return false;
}

function columnEquals(a: Column, b: Column): boolean {
  return (
    a.type === b.type &&
    a.nullable === b.nullable &&
    (a.default ?? null) === (b.default ?? null)
  );
}

function diffEnums(from: Snapshot, to: Snapshot, out: Change[]): void {
  const fromEnums = byName(from.enums);
  const toEnums = byName(to.enums);

  for (const e of to.enums) {
    if (!fromEnums.has(e.name)) out.push({ kind: "createEnum", enum: e });
  }
  for (const e of from.enums) {
    if (!toEnums.has(e.name)) out.push({ kind: "dropEnum", enum: e });
  }
  for (const e of to.enums) {
    const prev = fromEnums.get(e.name);
    if (!prev) continue;
    const prevSet = new Set(prev.values);
    const nextSet = new Set(e.values);
    // Added values: emit ALTER TYPE ... ADD VALUE, preserving position.
    for (let i = 0; i < e.values.length; i++) {
      const v = e.values[i];
      if (!prevSet.has(v)) {
        out.push({
          kind: "addEnumValue",
          enum: e.name,
          value: v,
          after: i > 0 ? e.values[i - 1] : null,
        });
      }
    }
    // Removed values: PostgreSQL cannot drop enum labels. Recorded as a
    // destructive, warning-only change (no executable SQL is emitted).
    for (const v of prev.values) {
      if (!nextSet.has(v)) {
        out.push({ kind: "dropEnumValue", enum: e.name, value: v });
      }
    }
  }
}

function diffColumns(table: string, from: Table, to: Table, out: Change[]): void {
  const fromCols = byName(from.columns);
  const toCols = byName(to.columns);

  for (const col of to.columns) {
    if (!fromCols.has(col.name)) {
      out.push({ kind: "addColumn", table, column: col });
    }
  }
  for (const col of from.columns) {
    if (!toCols.has(col.name)) {
      out.push({ kind: "dropColumn", table, column: col });
    }
  }
  for (const col of to.columns) {
    const prev = fromCols.get(col.name);
    if (!prev || columnEquals(prev, col)) continue;

    if (prev.type !== col.type) {
      out.push({
        kind: "alterColumnType",
        table,
        column: col.name,
        from: prev.type,
        to: col.type,
        destructive: !isSafeWiden(prev.type, col.type),
      });
    }
    if ((prev.default ?? null) !== (col.default ?? null)) {
      out.push({
        kind: "alterColumnDefault",
        table,
        column: col.name,
        from: prev.default ?? null,
        to: col.default ?? null,
      });
    }
    if (prev.nullable !== col.nullable) {
      out.push({
        kind: "alterColumnNullable",
        table,
        column: col.name,
        notNull: !col.nullable,
      });
    }
  }
}

function diffTableConstraints(
  table: string,
  from: Table,
  to: Table,
  out: Change[],
): void {
  // Primary key
  const fpk = from.primaryKey;
  const tpk = to.primaryKey;
  if (JSON.stringify(fpk) !== JSON.stringify(tpk)) {
    if (fpk) out.push({ kind: "dropPrimaryKey", table, pk: fpk });
    if (tpk) out.push({ kind: "addPrimaryKey", table, pk: tpk });
  }

  // Unique constraints (matched by name)
  const fu = byName(from.uniques);
  const tu = byName(to.uniques);
  for (const u of to.uniques) {
    const prev = fu.get(u.name);
    if (!prev) out.push({ kind: "addUnique", table, unique: u });
    else if (JSON.stringify(prev.columns) !== JSON.stringify(u.columns)) {
      out.push({ kind: "dropUnique", table, unique: prev });
      out.push({ kind: "addUnique", table, unique: u });
    }
  }
  for (const u of from.uniques) {
    if (!tu.has(u.name)) out.push({ kind: "dropUnique", table, unique: u });
  }

  // Foreign keys (matched by name)
  const ff = byName(from.foreignKeys);
  const tf = byName(to.foreignKeys);
  for (const fk of to.foreignKeys) {
    const prev = ff.get(fk.name);
    if (!prev) out.push({ kind: "addForeignKey", table, fk });
    else if (JSON.stringify(prev) !== JSON.stringify(fk)) {
      out.push({ kind: "dropForeignKey", table, fk: prev });
      out.push({ kind: "addForeignKey", table, fk });
    }
  }
  for (const fk of from.foreignKeys) {
    if (!tf.has(fk.name)) out.push({ kind: "dropForeignKey", table, fk });
  }

  // Indexes (matched by name, compared by definition)
  const fi = byName(from.indexes);
  const ti = byName(to.indexes);
  for (const idx of to.indexes) {
    const prev = fi.get(idx.name);
    if (!prev) out.push({ kind: "addIndex", table, index: idx });
    else if (normalizeIndexDef(prev.definition) !== normalizeIndexDef(idx.definition)) {
      out.push({ kind: "dropIndex", table, index: prev });
      out.push({ kind: "addIndex", table, index: idx });
    }
  }
  for (const idx of from.indexes) {
    if (!ti.has(idx.name)) out.push({ kind: "dropIndex", table, index: idx });
  }
}

/** Collapse whitespace so cosmetic differences in indexdef don't create noise. */
function normalizeIndexDef(def: string): string {
  return def.replace(/\s+/g, " ").trim();
}

export function diffSnapshots(from: Snapshot, to: Snapshot): Change[] {
  const out: Change[] = [];

  diffEnums(from, to, out);

  const fromTables = byName(from.tables);
  const toTables = byName(to.tables);

  for (const t of to.tables) {
    if (!fromTables.has(t.name)) {
      // A created table renders its columns, primary key and unique constraints
      // inline, but foreign keys and indexes are emitted as separate phased
      // changes so FKs still land last (after every referenced table exists) and
      // indexes land in their own phase. They are stripped from the createTable
      // payload so nothing is emitted twice.
      out.push({
        kind: "createTable",
        table: { ...t, foreignKeys: [], indexes: [] },
      });
      for (const fk of t.foreignKeys) {
        out.push({ kind: "addForeignKey", table: t.name, fk });
      }
      for (const idx of t.indexes) {
        out.push({ kind: "addIndex", table: t.name, index: idx });
      }
    }
  }
  for (const t of from.tables) {
    if (!toTables.has(t.name)) out.push({ kind: "dropTable", table: t });
  }
  for (const t of to.tables) {
    const prev = fromTables.get(t.name);
    if (!prev) continue;
    diffColumns(t.name, prev, t, out);
    diffTableConstraints(t.name, prev, t, out);
  }

  return sortChanges(out);
}

export function sortChanges(changes: Change[]): Change[] {
  return [...changes].sort((a, b) => {
    const oa = ORDER[a.kind];
    const ob = ORDER[b.kind];
    if (oa !== ob) return oa - ob;
    return secondaryKey(a).localeCompare(secondaryKey(b));
  });
}

/** A change is destructive if applying it can lose data or fail irreversibly. */
export function isDestructive(change: Change): boolean {
  switch (change.kind) {
    case "dropTable":
    case "dropColumn":
    case "dropEnumValue":
      return true;
    case "alterColumnType":
      return change.destructive;
    default:
      return false;
  }
}
