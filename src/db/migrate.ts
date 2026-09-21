import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../env.js';
import { closeDb, db } from './client.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Apply every migration file that is not in schema_migrations yet, in name order. */
export async function migrate(): Promise<string[]> {
  const sql = db();
  // The bookkeeping table lives in the engine's own schema like everything
  // else, so it has to exist before the first migration runs.
  await sql`create schema if not exists marketing`;
  await sql`
    create table if not exists marketing.schema_migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `;

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set(
    (await sql<{ name: string }[]>`select name from marketing.schema_migrations`).map((r) => r.name),
  );

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const body = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into marketing.schema_migrations (name) values (${file})`;
    });
    ran.push(file);
  }
  return ran;
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  // The container runs this before the service, so it is the first thing to
  // meet a bad environment. Say what is wrong, not where it was thrown.
  try {
    loadEnv();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  const ran = await migrate();
  console.log(ran.length ? `applied: ${ran.join(', ')}` : 'nothing to apply');
  await closeDb();
}
