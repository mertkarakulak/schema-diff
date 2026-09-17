#!/usr/bin/env node
/**
 * schema-diff CLI.
 *
 * Commands:
 *   schema-diff diff --from <conn|file> --to <conn|file> [options]
 *   schema-diff snapshot <conn> -o <file> [--schema public]
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { introspect } from "./introspect.js";
import { generateMigration } from "./sql.js";
import { isDestructive, type Change } from "./diff.js";
import type { Snapshot } from "./types.js";

const CONN_RE = /^postgres(ql)?:\/\//i;

function isConnectionString(input: string): boolean {
  return CONN_RE.test(input);
}

async function loadSnapshotFile(path: string): Promise<Snapshot> {
  const raw = await readFile(resolve(path), "utf8");
  const parsed = JSON.parse(raw) as Snapshot;
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.tables)) {
    throw new Error(`${path} is not a valid schema-diff snapshot (version 1)`);
  }
  return parsed;
}

async function resolveSnapshot(input: string, schema: string): Promise<Snapshot> {
  if (isConnectionString(input)) {
    return introspect(input, { schema });
  }
  if (!existsSync(resolve(input))) {
    throw new Error(
      `"${input}" is neither a postgres:// connection string nor an existing snapshot file`,
    );
  }
  const snap = await loadSnapshotFile(input);
  if (snap.schema !== schema && schema !== "public") {
    // Only warn: the user explicitly asked for a schema that differs from the file.
    process.stderr.write(
      `warning: snapshot ${input} was taken for schema "${snap.schema}" but --schema is "${schema}"\n`,
    );
  }
  return snap;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function summarize(changes: Change[]): string {
  const counts = new Map<string, number>();
  for (const c of changes) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  return [...counts.entries()]
    .map(([k, n]) => `  ${k}: ${n}`)
    .join("\n");
}

function describeDestructive(changes: Change[]): string[] {
  return changes.filter(isDestructive).map((c) => {
    switch (c.kind) {
      case "dropTable":
        return `drop table ${c.table.name}`;
      case "dropColumn":
        return `drop column ${c.table}.${c.column.name}`;
      case "dropEnumValue":
        return `remove enum value ${c.enum}.${c.value} (not supported by PostgreSQL)`;
      case "alterColumnType":
        return `narrow type ${c.table}.${c.column} (${c.from} -> ${c.to})`;
      default:
        return c.kind;
    }
  });
}

async function runDiff(opts: {
  from: string;
  to: string;
  schema: string;
  out?: string;
  print?: boolean;
  allowDestructive?: boolean;
}): Promise<number> {
  const [from, to] = await Promise.all([
    resolveSnapshot(opts.from, opts.schema),
    resolveSnapshot(opts.to, opts.schema),
  ]);

  const migration = generateMigration(from, to);

  if (!migration.hasChanges) {
    process.stderr.write("No differences between the two schemas.\n");
    return 0;
  }

  const destructive = describeDestructive(migration.upChanges);
  const blocked = destructive.length > 0 && !opts.allowDestructive;

  if (destructive.length > 0) {
    process.stderr.write(
      `\nDestructive change(s) detected:\n${destructive
        .map((d) => `  - ${d}`)
        .join("\n")}\n`,
    );
    if (blocked) {
      process.stderr.write(
        "\nRefusing to emit migration. Re-run with --allow-destructive to proceed.\n",
      );
    }
  }

  if (opts.print) {
    // SQL to stdout so it can be piped; diagnostics already went to stderr.
    process.stdout.write(migration.up);
    process.stdout.write(`\n-- ============ down.sql ============\n\n`);
    process.stdout.write(migration.down);
    return blocked ? 1 : 0;
  }

  if (blocked) return 1;

  const outDir = resolve(opts.out ?? join("migrations", `${timestamp()}_schema_diff`));
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "up.sql"), migration.up, "utf8");
  await writeFile(join(outDir, "down.sql"), migration.down, "utf8");

  process.stderr.write(
    `\nWrote migration to ${outDir}\n\nChange summary:\n${summarize(
      migration.upChanges,
    )}\n`,
  );
  return 0;
}

async function runSnapshot(conn: string, opts: { out: string; schema: string }): Promise<number> {
  if (!isConnectionString(conn)) {
    throw new Error("snapshot requires a postgres:// connection string");
  }
  const snap = await introspect(conn, { schema: opts.schema });
  const outPath = resolve(opts.out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(snap, null, 2) + "\n", "utf8");
  process.stderr.write(
    `Wrote snapshot of schema "${opts.schema}" (${snap.tables.length} tables, ${snap.enums.length} enums) to ${outPath}\n`,
  );
  return 0;
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("schema-diff")
    .description("Compare two PostgreSQL schemas and generate a reversible migration.")
    .version("0.1.0");

  program
    .command("diff")
    .description("Diff two schemas (live connections or snapshot files) into up.sql / down.sql")
    .requiredOption("--from <conn|file>", "source schema: postgres:// URL or snapshot .json")
    .requiredOption("--to <conn|file>", "target schema: postgres:// URL or snapshot .json")
    .option("--schema <name>", "schema to compare", "public")
    .option("--out <dir>", "output directory (default: ./migrations/<timestamp>_schema_diff)")
    .option("--print", "print SQL to stdout instead of writing files")
    .option("--allow-destructive", "permit destructive changes (drops, type narrowing)")
    .action(async (o) => {
      const code = await runDiff({
        from: o.from,
        to: o.to,
        schema: o.schema,
        out: o.out,
        print: o.print,
        allowDestructive: o.allowDestructive,
      });
      process.exitCode = code;
    });

  program
    .command("snapshot")
    .description("Introspect a live database into a portable JSON snapshot")
    .argument("<conn>", "postgres:// connection string")
    .requiredOption("-o, --out <file>", "output snapshot file (.json)")
    .option("--schema <name>", "schema to snapshot", "public")
    .action(async (conn, o) => {
      const code = await runSnapshot(conn, { out: o.out, schema: o.schema });
      process.exitCode = code;
    });

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exitCode = 1;
  }
}

void main();
