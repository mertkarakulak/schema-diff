/**
 * Data model for a PostgreSQL schema snapshot.
 *
 * A snapshot is plain, serializable JSON. The diff engine only ever operates on
 * these structures, never on a live database connection. This keeps the core
 * deterministic and trivially testable with fixtures.
 */

export interface Column {
  name: string;
  /** Canonical type as produced by `format_type()`, e.g. `character varying(255)`, `integer`, `numeric(10,2)`, `text[]`. */
  type: string;
  nullable: boolean;
  /** Raw default expression from `pg_get_expr()`, e.g. `nextval('t_id_seq'::regclass)`, `'active'::text`, or null. */
  default: string | null;
}

export interface PrimaryKey {
  name: string;
  columns: string[];
}

export interface UniqueConstraint {
  name: string;
  columns: string[];
}

export interface ForeignKey {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onUpdate: ReferentialAction;
  onDelete: ReferentialAction;
}

export type ReferentialAction =
  | "NO ACTION"
  | "RESTRICT"
  | "CASCADE"
  | "SET NULL"
  | "SET DEFAULT";

export interface Index {
  name: string;
  /** Full `CREATE INDEX` definition from `pg_indexes.indexdef` (excludes constraint-backing indexes). */
  definition: string;
}

export interface Table {
  name: string;
  /** Ordered by ordinal position, as in the database. */
  columns: Column[];
  primaryKey: PrimaryKey | null;
  uniques: UniqueConstraint[];
  foreignKeys: ForeignKey[];
  indexes: Index[];
}

export interface EnumType {
  name: string;
  /** Ordered enum labels. */
  values: string[];
}

export interface Snapshot {
  /** Snapshot format version, for forward compatibility. */
  version: 1;
  schema: string;
  tables: Table[];
  enums: EnumType[];
  /** Optional provenance metadata; ignored by the diff engine. */
  meta?: {
    generatedAt?: string;
    source?: string;
    tool?: string;
  };
}
