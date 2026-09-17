/**
 * Test-only reference "applier": mutate a Snapshot by a list of Changes.
 *
 * This is deliberately independent of the SQL generator. It lets us assert the
 * core completeness property the whole tool rests on:
 *
 *   applyChanges(from, diffSnapshots(from, to)) structurally equals `to`
 *
 * If the diff ever fails to capture a difference, this property breaks -- it is a
 * far stronger check than any single hand-written expected-SQL assertion.
 */

import type { Change } from "../src/diff.js";
import type { Snapshot, Table } from "../src/types.js";

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function findTable(snap: Snapshot, name: string): Table {
  const t = snap.tables.find((x) => x.name === name);
  if (!t) throw new Error(`applyChanges: table ${name} not found`);
  return t;
}

export function applyChanges(base: Snapshot, changes: Change[]): Snapshot {
  const snap = clone(base);

  for (const c of changes) {
    switch (c.kind) {
      case "createEnum":
        snap.enums.push(clone(c.enum));
        break;
      case "dropEnum":
        snap.enums = snap.enums.filter((e) => e.name !== c.enum.name);
        break;
      case "addEnumValue": {
        const e = snap.enums.find((x) => x.name === c.enum);
        if (!e) throw new Error(`addEnumValue: enum ${c.enum} missing`);
        if (c.after === null) e.values.unshift(c.value);
        else {
          const idx = e.values.indexOf(c.after);
          e.values.splice(idx + 1, 0, c.value);
        }
        break;
      }
      case "dropEnumValue": {
        const e = snap.enums.find((x) => x.name === c.enum);
        if (e) e.values = e.values.filter((v) => v !== c.value);
        break;
      }
      case "createTable":
        snap.tables.push(clone(c.table));
        break;
      case "dropTable":
        snap.tables = snap.tables.filter((t) => t.name !== c.table.name);
        break;
      case "addColumn":
        findTable(snap, c.table).columns.push(clone(c.column));
        break;
      case "dropColumn": {
        const t = findTable(snap, c.table);
        t.columns = t.columns.filter((col) => col.name !== c.column.name);
        break;
      }
      case "alterColumnType": {
        const col = findTable(snap, c.table).columns.find((x) => x.name === c.column)!;
        col.type = c.to;
        break;
      }
      case "alterColumnNullable": {
        const col = findTable(snap, c.table).columns.find((x) => x.name === c.column)!;
        col.nullable = !c.notNull;
        break;
      }
      case "alterColumnDefault": {
        const col = findTable(snap, c.table).columns.find((x) => x.name === c.column)!;
        col.default = c.to;
        break;
      }
      case "addPrimaryKey":
        findTable(snap, c.table).primaryKey = clone(c.pk);
        break;
      case "dropPrimaryKey":
        findTable(snap, c.table).primaryKey = null;
        break;
      case "addUnique":
        findTable(snap, c.table).uniques.push(clone(c.unique));
        break;
      case "dropUnique": {
        const t = findTable(snap, c.table);
        t.uniques = t.uniques.filter((u) => u.name !== c.unique.name);
        break;
      }
      case "addForeignKey":
        findTable(snap, c.table).foreignKeys.push(clone(c.fk));
        break;
      case "dropForeignKey": {
        const t = findTable(snap, c.table);
        t.foreignKeys = t.foreignKeys.filter((f) => f.name !== c.fk.name);
        break;
      }
      case "addIndex":
        findTable(snap, c.table).indexes.push(clone(c.index));
        break;
      case "dropIndex": {
        const t = findTable(snap, c.table);
        t.indexes = t.indexes.filter((i) => i.name !== c.index.name);
        break;
      }
    }
  }

  return snap;
}

/** Order-insensitive normalization so two structurally equal schemas compare equal. */
export function normalize(snap: Snapshot): unknown {
  const byName = <T extends { name: string }>(arr: T[]) =>
    [...arr].sort((a, b) => a.name.localeCompare(b.name));
  return {
    schema: snap.schema,
    enums: byName(snap.enums).map((e) => ({ name: e.name, values: e.values })),
    tables: byName(snap.tables).map((t) => ({
      name: t.name,
      columns: byName(t.columns),
      primaryKey: t.primaryKey,
      uniques: byName(t.uniques),
      foreignKeys: byName(t.foreignKeys),
      indexes: byName(t.indexes),
    })),
  };
}
