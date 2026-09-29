import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, withTenant } from "../src/client.js";
import { installQueue } from "../src/install-queue.js";
import { runMigrations } from "../src/migrate.js";
import {
  createBoss,
  enqueueProcessMessage,
  ensureQueues,
  type ProcessMessageJob,
  QUEUES,
} from "../src/queue.js";
import * as schema from "../src/schema/index.js";

/**
 * Prueba pg-boss contra un Postgres real (PGlite no sirve para LISTEN ni para varias conexiones).
 * Se salta si no hay TEST_DATABASE_URL. En local: postgres://postgres@127.0.0.1:5433/caja_test
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("cola pg-boss sobre Postgres", () => {
  let boss: PgBoss;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    if (!url) return;
    const admin = (await import("postgres")).default(url, { max: 1 });
    await admin.unsafe(
      "DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; DROP SCHEMA IF EXISTS caja_meta CASCADE;",
    );
    await admin.end();
    await runMigrations(url);
    await installQueue(url);
    db = createDb(url, { max: 3 });
    boss = createBoss(url, "worker");
    await boss.start();
    await ensureQueues(boss);
    await boss.deleteAllJobs(QUEUES.processMessage);
  });

  afterAll(async () => {
    if (!url) return;
    await boss.stop({ graceful: false, close: true });
    await db.close();
  });

  const job = (n: number, key: string): ProcessMessageJob => ({
    webhookEventId: `00000000-0000-4000-8000-00000000000${n}`,
    waMessageId: `wamid.${key}.${n}`,
    phoneNumberId: "P",
    senderE164: key,
    senderWaUserId: null,
  });

  it("encola dentro de la transacción: si la transacción falla, no queda job", async () => {
    await expect(
      db.db.transaction(async (tx) => {
        await enqueueProcessMessage(boss, tx, job(1, "58412"), "58412");
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    const pending = await boss.findJobs<ProcessMessageJob>(QUEUES.processMessage, {
      state: "created",
    } as never);
    expect(pending.filter((j) => j.data.waMessageId === "wamid.58412.1")).toHaveLength(0);
  });

  it("key_strict_fifo: mismo teléfono en orden y uno a la vez; teléfonos distintos en paralelo", async () => {
    const events: string[] = [];
    let active = 0;
    let maxActiveSameKey = 0;
    await boss.work<ProcessMessageJob>(
      QUEUES.processMessage,
      { batchSize: 1, pollingIntervalSeconds: 0.5, localConcurrency: 4 },
      async (jobs) => {
        for (const j of jobs) {
          if (j.data.senderE164 === "A") {
            active += 1;
            maxActiveSameKey = Math.max(maxActiveSameKey, active);
          }
          await new Promise((r) => setTimeout(r, 150));
          events.push(j.data.waMessageId);
          if (j.data.senderE164 === "A") active -= 1;
        }
      },
    );
    // Una transacción por mensaje, como hace la ingesta real: el orden FIFO se decide por created_on.
    for (let n = 1; n <= 3; n++) {
      await db.db.transaction((tx) => enqueueProcessMessage(boss, tx, job(n, "A"), "A"));
    }
    await db.db.transaction((tx) => enqueueProcessMessage(boss, tx, job(4, "B"), "B"));
    const deadline = Date.now() + 15_000;
    while (events.length < 4 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(events.filter((e) => e.startsWith("wamid.A."))).toEqual([
      "wamid.A.1",
      "wamid.A.2",
      "wamid.A.3",
    ]);
    expect(maxActiveSameKey).toBe(1);
    expect(events).toContain("wamid.B.4");
  });

  it("el rol caja_app puede usar la cola y sigue sujeto a RLS", async () => {
    const admin = (await import("postgres")).default(url ?? "", { max: 1 });
    await admin.unsafe("ALTER ROLE caja_app LOGIN PASSWORD 'test'");
    await admin.end();
    const appUrl = (url ?? "").replace("postgres://postgres@", "postgres://caja_app:test@");
    const app = createDb(appUrl, { max: 1 });
    const appBoss = createBoss(appUrl, "producer");
    await appBoss.start();
    try {
      const tenants = await app.db.select().from(schema.tenant);
      expect(tenants).toHaveLength(0);
      await expect(
        withTenant(app.db, "99999999-9999-4999-8999-999999999999", async (tx) => {
          await enqueueProcessMessage(appBoss, tx, job(5, "C"), "C");
        }),
      ).resolves.toBeUndefined();
    } finally {
      await appBoss.stop({ graceful: false, close: true });
      await app.close();
    }
  });
});
