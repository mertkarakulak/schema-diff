# schema-diff

[![CI](https://github.com/mertkarakulak/schema-diff/actions/workflows/ci.yml/badge.svg)](https://github.com/mertkarakulak/schema-diff/actions/workflows/ci.yml)

**Compare two PostgreSQL schemas and generate a reversible migration — `up.sql` and `down.sql` — from live databases or portable JSON snapshots.**

`schema-diff` introspects PostgreSQL through `pg_catalog`, builds a plain-JSON model of each schema, and runs a deterministic, pure diff engine over the two models. The result is an ordered pair of SQL scripts wrapped in a transaction, with destructive changes flagged and blocked by default.

## Why

Most "diff my database" tooling is either tied to a full migration framework or hides the SQL it runs. `schema-diff` does one thing: it shows you the exact DDL that turns schema A into schema B, and the exact DDL that reverses it. The diff engine is a pure function over JSON snapshots, so the output is deterministic and easy to review in a pull request. Snapshots are portable, so you can diff production against a file captured in CI without granting anyone two live connections at once.

## Install

From source:

```bash
git clone https://github.com/mertkarakulak/schema-diff.git
cd schema-diff
npm install
npm run build
node dist/cli.js --help
```

Run directly from GitHub with npx (no clone):

```bash
npx github:mertkarakulak/schema-diff --help
```

As a dependency (once installed into a project):

```bash
npm install @mertkarakulak/schema-diff
```

## Usage

### Diff two live databases

```bash
schema-diff diff \
  --from postgres://user:pass@localhost:5432/prod \
  --to   postgres://user:pass@localhost:5432/staging \
  --schema public \
  --out ./migrations/2026_new_release
```

This writes `up.sql` and `down.sql` into the output directory. If `--out` is omitted, files go to `./migrations/<timestamp>_schema_diff/`.

### Diff using snapshots (no simultaneous connections)

```bash
schema-diff snapshot postgres://user:pass@host/prod    -o prod.json
schema-diff snapshot postgres://user:pass@host/staging -o staging.json
schema-diff diff --from prod.json --to staging.json --print
```

`--from` and `--to` accept either a `postgres://` connection string or a snapshot `.json` file, in any combination.

### Print instead of writing files

```bash
schema-diff diff --from prod.json --to staging.json --print > review.sql
```

SQL goes to **stdout**; warnings and summaries go to **stderr**, so redirecting stdout captures clean SQL.

### Example output

Given a schema that adds a table, widens a column, adds an enum, and drops a legacy column, `up.sql` looks like:

```sql
-- schema-diff up migration
-- schema: public
-- generated: 2026-09-17T12:00:00.000Z

BEGIN;

CREATE TYPE "public"."role" AS ENUM ('admin', 'member');

-- WARNING: destructive
ALTER TABLE "public"."users" DROP COLUMN "legacy_notes";

ALTER TABLE "public"."users" ALTER COLUMN "email" TYPE character varying(255) USING "email"::character varying(255);

ALTER TABLE "public"."users" ADD COLUMN "bio" text;

CREATE TABLE "public"."comments" (
  "id" integer NOT NULL DEFAULT nextval('comments_id_seq'::regclass),
  "post_id" integer NOT NULL,
  "body" text NOT NULL,
  CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

ALTER TYPE "public"."status" ADD VALUE IF NOT EXISTS 'archived' AFTER 'inactive';

CREATE INDEX users_email_lower_idx ON public.users USING btree (lower((email)::text));

ALTER TABLE "public"."comments" ADD CONSTRAINT "comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."posts" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;

COMMIT;
```

The matching `down.sql` reverses these operations in the correct order and annotates recreated tables/columns:

```sql
-- NOTE: data cannot be restored; this recreates a column the up migration dropped
ALTER TABLE "public"."users" ADD COLUMN "legacy_notes" text;
```

## Destructive change safety

A change is **destructive** when applying it can lose data or fail irreversibly:

- `DROP TABLE`, `DROP COLUMN`
- Type changes that are not known-safe widenings (e.g. `text -> varchar(200)`, `bigint -> integer`)
- Removing a value from an enum (PostgreSQL cannot do this at all — it is reported as a warning, never as SQL)

Every destructive statement is prefixed with `-- WARNING: destructive`. By default the CLI **refuses to emit the migration and exits non-zero** when destructive changes are present. Pass `--allow-destructive` to proceed:

```bash
schema-diff diff --from a.json --to b.json --allow-destructive
```

`schema-diff` also emits non-blocking hazard notes for statements that are valid but can fail at apply time depending on data — for example adding a `NOT NULL` column without a default, or `SET NOT NULL` on a column that may contain `NULL`s.

Ordering is deterministic and dependency-safe: foreign keys and constraints are dropped before their tables, tables and columns are created before the constraints and indexes that reference them, enums are created before their consumers and dropped after, and foreign keys are added last.

## What is supported

- Tables: create / drop
- Columns: add / drop, type change (with safe-widening detection), nullability, default
- Primary keys, unique constraints, foreign keys (with `ON UPDATE` / `ON DELETE`)
- Indexes (via `pg_get_indexdef`, excluding constraint-backing indexes)
- Enum types: create / drop, and adding values (`ALTER TYPE ... ADD VALUE`)
- `--schema` filter (default `public`)
- Reversible `down.sql` generated by diffing in reverse — not by fragile inversion logic

## What is NOT supported

This tool is deliberately scoped to the object types above. It does **not** handle:

- Views, materialized views
- Functions, procedures, triggers
- Partitioned tables and partitions
- Sequences and `serial` / `GENERATED AS IDENTITY` ownership. A `serial` column is read honestly as `integer` with a `nextval(...)` default, but the underlying sequence is **not** created or diffed. Creating a new table with a `serial`-style default in a generated migration will fail unless the sequence already exists.
- Row-level security policies, grants / privileges, ownership, comments
- Collations, domains, composite/range types, extensions
- Cross-schema diffs in a single run (one `--schema` at a time)
- Data migration of any kind (structure only)

Enum value **additions** run inside the transaction, which requires PostgreSQL 12+. Enum value **removals** are impossible in PostgreSQL and are reported as warnings only. Default expressions are compared textually as PostgreSQL renders them (with casts, e.g. `'active'::text`), so two semantically identical defaults created differently may show as a diff.

## Programmatic API

```ts
import { introspect, diffSnapshots, generateMigration } from "@mertkarakulak/schema-diff";

const from = await introspect("postgres://.../prod", { schema: "public" });
const to = await introspect("postgres://.../staging", { schema: "public" });

const changes = diffSnapshots(from, to); // pure, deterministic Change[]
const { up, down, destructiveChanges } = generateMigration(from, to);
```

## Development

```bash
npm install
npm run build      # tsc -> dist/
npm run lint       # tsc --noEmit
npm test           # vitest (unit tests, no database required)
```

The diff engine and SQL generator are covered by extensive unit tests using JSON fixture snapshots — no database needed. A property test asserts that applying the generated `up` changes to the `from` snapshot reproduces `to`, in both directions.

An integration test runs only when `DATABASE_URL` is set; otherwise it is skipped:

```bash
docker run -d --name schema-diff-pg -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
```

It builds two schemas against the real server, generates the migration, applies `up.sql` and asserts the database now matches the target, then applies `down.sql` and asserts it is back to the original — the check that introspection and SQL generation agree.

## License

MIT © 2026 Mert Karakulak
