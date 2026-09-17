/**
 * Integration test against a real PostgreSQL server.
 *
 * Skipped unless DATABASE_URL is set. It validates the thing unit tests cannot:
 * that introspection and SQL generation AGREE with each other. It builds schema
 * A, snapshots it, builds schema B, snapshots it, generates the migration, then
 * applies up.sql onto A and asserts the result equals B, and applies down.sql and
 * asserts it returns to A.
 *
 * Note: fixtures use explicit integer primary keys (not `serial`) because
 * schema-diff does not manage sequences -- see the README "Not supported".
 */

import { describe, expect, it } from "vitest";
import pg from "pg";
import { introspectWithClient } from "../src/introspect.js";
import { generateMigration } from "../src/sql.js";
import { normalize } from "./apply.js";

const { Client } = pg;
const url = process.env.DATABASE_URL;
const maybe = url ? describe : describe.skip;

const DDL_A = [
  `CREATE TYPE mood AS ENUM ('ok', 'bad')`,
  `CREATE TABLE users (
     id integer NOT NULL,
     email character varying(100) NOT NULL,
     note text,
     CONSTRAINT users_pkey PRIMARY KEY (id),
     CONSTRAINT users_email_key UNIQUE (email)
   )`,
  `CREATE TABLE posts (
     id integer NOT NULL,
     user_id integer NOT NULL,
     title text NOT NULL,
     CONSTRAINT posts_pkey PRIMARY KEY (id),
     CONSTRAINT posts_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX idx_posts_title ON posts (title)`,
  `CREATE TABLE temp_logs (
     id integer NOT NULL,
     msg text,
     CONSTRAINT temp_logs_pkey PRIMARY KEY (id)
   )`,
];

const DDL_B = [
  `CREATE TYPE mood AS ENUM ('ok', 'bad')`,
  `CREATE TYPE role AS ENUM ('admin', 'user')`,
  `CREATE TABLE users (
     id integer NOT NULL,
     email character varying(200) NOT NULL,
     active boolean NOT NULL DEFAULT true,
     role role NOT NULL DEFAULT 'user',
     CONSTRAINT users_pkey PRIMARY KEY (id),
     CONSTRAINT users_email_key UNIQUE (email)
   )`,
  `CREATE TABLE posts (
     id integer NOT NULL,
     user_id integer NOT NULL,
     title character varying(255) NOT NULL,
     published boolean NOT NULL DEFAULT false,
     CONSTRAINT posts_pkey PRIMARY KEY (id),
     CONSTRAINT posts_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX idx_posts_pub ON posts (published)`,
  `CREATE TABLE comments (
     id integer NOT NULL,
     post_id integer NOT NULL,
     body text NOT NULL,
     CONSTRAINT comments_pkey PRIMARY KEY (id),
     CONSTRAINT comments_post_id_fkey FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
   )`,
  `CREATE INDEX idx_comments_post_id ON comments (post_id)`,
];

async function reset(client: pg.Client): Promise<void> {
  await client.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
}

async function build(client: pg.Client, ddl: string[]): Promise<void> {
  for (const stmt of ddl) await client.query(stmt);
}

maybe("integration (real PostgreSQL)", () => {
  it(
    "round-trips introspection + reversible migration",
    async () => {
      const client = new Client({ connectionString: url });
      await client.connect();
      try {
        await reset(client);
        await build(client, DDL_A);
        const snapA = await introspectWithClient(client, "public");

        await reset(client);
        await build(client, DDL_B);
        const snapB = await introspectWithClient(client, "public");

        const { up, down, destructiveChanges } = generateMigration(snapA, snapB);
        expect(destructiveChanges.length).toBeGreaterThan(0); // drops + narrowing

        // Apply up onto A, expect B.
        await reset(client);
        await build(client, DDL_A);
        await client.query(up);
        const afterUp = await introspectWithClient(client, "public");
        expect(normalize(afterUp)).toEqual(normalize(snapB));

        // Apply down, expect A again.
        await client.query(down);
        const afterDown = await introspectWithClient(client, "public");
        expect(normalize(afterDown)).toEqual(normalize(snapA));
      } finally {
        await client.end();
      }
    },
    60_000,
  );
});
