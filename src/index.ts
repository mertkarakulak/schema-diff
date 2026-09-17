/**
 * Public API for @mertkarakulak/schema-diff.
 *
 * The library is usable programmatically without the CLI:
 *
 *   import { introspect, diffSnapshots, generateMigration } from "@mertkarakulak/schema-diff";
 */

export type {
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

export { diffSnapshots, sortChanges, isDestructive, isSafeWiden } from "./diff.js";
export type { Change } from "./diff.js";

export { generateMigration } from "./sql.js";
export type { Migration } from "./sql.js";

export { introspect, introspectWithClient } from "./introspect.js";
export type { IntrospectOptions } from "./introspect.js";
