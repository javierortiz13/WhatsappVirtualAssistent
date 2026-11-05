import { eq, schema, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { monthOutbound, nudgeStats } from "../src/inbox/nudge";
import { reminderStats } from "../src/reminders/stats";

/** G1-3: las señales para frenar en /admin, por negocio y sin mezclarse. Solo conteos. */
describe("conteos de apagados, fallidos y salientes (G1-3)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let a = "";
  let b = "";
  let phoneA = "";
  let phoneB = "";
  const now = new Date("2026-11-20T23:00:00Z");
  const H = 3_600_000;

  const out = (tenantId: string, phoneId: string, name: string, at: Date, status = "ok") =>
    withTenant(t.db, tenantId, (tx) =>
      tx.insert(schema.message).values({
        tenantId,
        phoneId,
        direction: "out",
        kind: "text",
        body: "x",
        status,
        createdAt: at,
        toolCalls: [{ name, args: {} }],
      }),
    );
  const off = (tenantId: string, phoneId: string, action: string, at: Date) =>
    withTenant(t.db, tenantId, (tx) =>
      tx.insert(schema.auditLog).values({
        tenantId,
        actorType: "phone",
        actorId: phoneId,
        action,
        entity: "phone_number",
        entityId: phoneId,
        after: { source: "button" },
        channel: "whatsapp",
        createdAt: at,
      }),
    );

  beforeAll(async () => {
    t = await createTestDb();
    a = await seedTenant(t.db, { name: "A", businessType: "food", ownerPhone: "584121000001" });
    b = await seedTenant(t.db, { name: "B", businessType: "food", ownerPhone: "584121000002" });
    const phones = await t.db.select().from(schema.phoneNumber);
    phoneA = phones.find((p) => p.tenantId === a)?.id ?? "";
    phoneB = phones.find((p) => p.tenantId === b)?.id ?? "";
    // A: un cierre del día y, 2 h después, «no me recuerdes»; otro apagado sin mensaje antes.
    await out(a, phoneA, "habit_close", new Date(now.getTime() - 26 * H));
    await off(a, phoneA, "nudge_off", new Date(now.getTime() - 24 * H));
    await off(a, phoneA, "all_off", new Date(now.getTime() - 5 * 24 * H));
    await t.db
      .update(schema.phoneNumber)
      .set({ prefPending: "nudges_off" })
      .where(eq(schema.phoneNumber.id, phoneA));
    // A: un recordatorio fallido.
    await out(a, phoneA, "reminder_b", new Date(now.getTime() - 2 * 24 * H), "failed");
    // B: lo mismo, para ver que no se mezcla.
    await out(b, phoneB, "habit_nudge", new Date(now.getTime() - 3 * H));
    await off(b, phoneB, "all_off", new Date(now.getTime() - 2 * H));
  });
  afterAll(() => t.close());

  it("cada negocio ve lo suyo", async () => {
    const since = new Date(now.getTime() - 14 * 24 * H);
    const sa = await withTenant(t.db, a, (tx) => nudgeStats(tx, a, since, now));
    expect(sa).toMatchObject({ nudgeOffs: 1, allOffs: 1, offsAfterSend: 1, pendingCards: 1 });
    const sb = await withTenant(t.db, b, (tx) => nudgeStats(tx, b, since, now));
    expect(sb).toMatchObject({ nudgeOffs: 0, allOffs: 1, offsAfterSend: 1, pendingCards: 0 });
    expect((await withTenant(t.db, a, (tx) => reminderStats(tx, a, since))).failed).toBe(1);
    expect((await withTenant(t.db, b, (tx) => reminderStats(tx, b, since))).failed).toBe(0);
  });

  it("salientes del mes: solo los que salieron, desde el día 1 de Caracas", async () => {
    // A: el cierre (19/11) cuenta; el fallido no; uno del 31/10 tampoco.
    await out(a, phoneA, "x", new Date("2026-10-31T20:00:00Z"));
    await out(a, phoneA, "x", new Date("2026-11-01T04:30:00Z"));
    expect(await withTenant(t.db, a, (tx) => monthOutbound(tx, a, now))).toBe(2);
    expect(await withTenant(t.db, b, (tx) => monthOutbound(tx, b, now))).toBe(1);
  });
});
