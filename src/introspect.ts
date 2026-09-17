/**
 * Live-database introspection: read a PostgreSQL schema into a `Snapshot`.
 *
 * Uses pg_catalog rather than information_schema so that:
 *  - column types come from `format_type()` (canonical, round-trippable,
 *    e.g. `character varying(255)`, `numeric(10,2)`, `text[]`);
 *  - defaults come from `pg_get_expr()`;
 *  - constraint-backing indexes are excluded by `pg_constraint.conindid`
 *    (matched by OID, not by name) so PK/UNIQUE indexes are not double-counted.
 */

import pg from "pg";
import type {
  Column,
  EnumType,
  ForeignKey,
  Index,
  PrimaryKey,
  ReferentialAction,
  Snapshot,
  Table,
  UniqueConstraint,
} from "./types.js";

const { Client } = pg;

const ACTION: Record<string, ReferentialAction> = {
  a: "NO ACTION",
  r: "RESTRICT",
  c: "CASCADE",
  n: "SET NULL",
  d: "SET DEFAULT",
};

export interface IntrospectOptions {
  schema?: string;
}

export async function introspect(
  connectionString: string,
  options: IntrospectOptions = {},
): Promise<Snapshot> {
  const schema = options.schema ?? "public";
  const client = new Client({ connectionString });
  await client.connect();
  try {
    return await introspectWithClient(client, schema);
  } finally {
    await client.end();
  }
}

export async function introspectWithClient(
  client: pg.Client,
  schema: string,
): Promise<Snapshot> {
  const tables = new Map<string, Table>();

  const tableRows = await client.query<{ name: string }>(
    `SELECT c.relname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r'
      ORDER BY c.relname`,
    [schema],
  );
  for (const r of tableRows.rows) {
    tables.set(r.name, {
      name: r.name,
      columns: [],
      primaryKey: null,
      uniques: [],
      foreignKeys: [],
      indexes: [],
    });
  }

  // Columns (ordered by attnum)
  const colRows = await client.query<{
    table_name: string;
    name: string;
    type: string;
    nullable: boolean;
    default: string | null;
  }>(
    `SELECT c.relname AS table_name,
            a.attname AS name,
            format_type(a.atttypid, a.atttypmod) AS type,
            NOT a.attnotnull AS nullable,
            pg_get_expr(ad.adbin, ad.adrelid) AS "default"
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relkind = 'r'
        AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`,
    [schema],
  );
  for (const r of colRows.rows) {
    const t = tables.get(r.table_name);
    if (!t) continue;
    const col: Column = {
      name: r.name,
      type: r.type,
      nullable: r.nullable,
      default: r.default,
    };
    t.columns.push(col);
  }

  // Primary keys and unique constraints
  const pkuRows = await client.query<{
    table_name: string;
    name: string;
    type: "p" | "u";
    columns: string[];
  }>(
    `SELECT c.relname AS table_name,
            con.conname AS name,
            con.contype AS type,
            (SELECT array_agg(att.attname::text ORDER BY k.ord)
               FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute att
                 ON att.attrelid = con.conrelid AND att.attnum = k.attnum
            ) AS columns
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND con.contype IN ('p', 'u')
      ORDER BY c.relname, con.conname`,
    [schema],
  );
  for (const r of pkuRows.rows) {
    const t = tables.get(r.table_name);
    if (!t) continue;
    if (r.type === "p") {
      const pk: PrimaryKey = { name: r.name, columns: r.columns };
      t.primaryKey = pk;
    } else {
      const u: UniqueConstraint = { name: r.name, columns: r.columns };
      t.uniques.push(u);
    }
  }

  // Foreign keys
  const fkRows = await client.query<{
    table_name: string;
    name: string;
    ref_table: string;
    columns: string[];
    ref_columns: string[];
    on_update: string;
    on_delete: string;
  }>(
    `SELECT c.relname AS table_name,
            con.conname AS name,
            rc.relname AS ref_table,
            con.confupdtype AS on_update,
            con.confdeltype AS on_delete,
            (SELECT array_agg(att.attname::text ORDER BY k.ord)
               FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute att
                 ON att.attrelid = con.conrelid AND att.attnum = k.attnum
            ) AS columns,
            (SELECT array_agg(att.attname::text ORDER BY k.ord)
               FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute att
                 ON att.attrelid = con.confrelid AND att.attnum = k.attnum
            ) AS ref_columns
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class rc ON rc.oid = con.confrelid
      WHERE n.nspname = $1 AND con.contype = 'f'
      ORDER BY c.relname, con.conname`,
    [schema],
  );
  for (const r of fkRows.rows) {
    const t = tables.get(r.table_name);
    if (!t) continue;
    const fk: ForeignKey = {
      name: r.name,
      columns: r.columns,
      refTable: r.ref_table,
      refColumns: r.ref_columns,
      onUpdate: ACTION[r.on_update] ?? "NO ACTION",
      onDelete: ACTION[r.on_delete] ?? "NO ACTION",
    };
    t.foreignKeys.push(fk);
  }

  // Indexes, excluding constraint-backing ones (by OID)
  const idxRows = await client.query<{
    table_name: string;
    name: string;
    def: string;
  }>(
    `SELECT c.relname AS table_name,
            i.relname AS name,
            pg_get_indexdef(idx.indexrelid) AS def
       FROM pg_index idx
       JOIN pg_class c ON c.oid = idx.indrelid
       JOIN pg_class i ON i.oid = idx.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r'
        AND NOT EXISTS (
          SELECT 1 FROM pg_constraint con WHERE con.conindid = idx.indexrelid
        )
      ORDER BY c.relname, i.relname`,
    [schema],
  );
  for (const r of idxRows.rows) {
    const t = tables.get(r.table_name);
    if (!t) continue;
    const idx: Index = { name: r.name, definition: r.def };
    t.indexes.push(idx);
  }

  // Enums
  const enumRows = await client.query<{ name: string; values: string[] }>(
    `SELECT t.typname AS name,
            (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
               FROM pg_enum e WHERE e.enumtypid = t.oid) AS values
       FROM pg_type t
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1 AND t.typtype = 'e'
      ORDER BY t.typname`,
    [schema],
  );
  const enums: EnumType[] = enumRows.rows.map((r) => ({
    name: r.name,
    values: r.values ?? [],
  }));

  return {
    version: 1,
    schema,
    tables: [...tables.values()],
    enums,
    meta: {
      generatedAt: new Date().toISOString(),
      source: "introspection",
      tool: "schema-diff",
    },
  };
}
