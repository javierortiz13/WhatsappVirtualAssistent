import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, withTenant } from "../src/client";
import { checkHealth } from "../src/health";
import { installQueue } from "../src/install-queue";
import { runMigrations } from "../src/migrate";
import {
  cancelFailedFifoJobs,
  createBoss,
  enqueueProcessMessage,
  ensureQueues,
  type ProcessMessageJob,
  QUEUES,
} from "../src/queue";
import * as schema from "../src/schema/index";

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

  it("un job en failed bloquea su teléfono; cancelFailedFifoJobs lo libera", async () => {
    const seen: string[] = [];
    await boss.offWork(QUEUES.processMessage);
    await boss.work<ProcessMessageJob>(
      QUEUES.processMessage,
      { batchSize: 1, pollingIntervalSeconds: 0.5 },
      async (jobs) => {
        for (const j of jobs) {
          seen.push(j.data.waMessageId);
          if (j.data.waMessageId === "wamid.F.1") throw new Error("boom");
        }
      },
    );
    // retryLimit 1 y retryDelay 15 s: para que quede en failed rápido, sin reintento.
    await boss.updateQueue(QUEUES.processMessage, { retryLimit: 0 });
    await db.db.transaction((tx) => enqueueProcessMessage(boss, tx, job(1, "F"), "F"));
    const wait = async (pred: () => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!pred() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    };
    await wait(() => seen.includes("wamid.F.1"));
    await new Promise((r) => setTimeout(r, 1_000));
    await db.db.transaction((tx) => enqueueProcessMessage(boss, tx, job(2, "F"), "F"));
    await new Promise((r) => setTimeout(r, 2_000));
    expect(seen).not.toContain("wamid.F.2");
    const cancelled = await cancelFailedFifoJobs(db.db);
    expect(cancelled.map((c) => c.webhookEventId)).toContain(job(1, "F").webhookEventId);
    await wait(() => seen.includes("wamid.F.2"));
    expect(seen).toContain("wamid.F.2");
    await boss.updateQueue(QUEUES.processMessage, { retryLimit: 1 });
  });

  it("checkHealth: worker vivo solo si housekeeping terminó hace poco; cola atascada si un job espera", async () => {
    await boss.offWork(QUEUES.processMessage);
    const now = new Date();
    const before = await checkHealth(db.db, now);
    expect(before.db).toBe(true);
    expect(before.worker.ok).toBe(false);
    // Un housekeeping terminado hace 1 minuto: worker vivo.
    await boss.work(QUEUES.housekeeping, { pollingIntervalSeconds: 0.5 }, async () => {});
    await boss.send(QUEUES.housekeeping, {});
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const h = await checkHealth(db.db, new Date());
      if (h.worker.ok) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const alive = await checkHealth(db.db, new Date());
    expect(alive.worker.ok).toBe(true);
    expect(alive.ok).toBe(true);
    // Un mensaje esperando 5 minutos sin que nadie lo tome: cola atascada.
    await db.db.transaction((tx) => enqueueProcessMessage(boss, tx, job(6, "H"), "H"));
    const later = new Date(Date.now() + 5 * 60_000);
    const stuck = await checkHealth(db.db, later);
    expect(stuck.queue.ok).toBe(false);
    expect(stuck.queue.waiting).toBeGreaterThanOrEqual(1);
    expect(stuck.ok).toBe(false);
    await boss.deleteAllJobs(QUEUES.processMessage);
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
