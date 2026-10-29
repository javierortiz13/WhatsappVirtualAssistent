import { eq, schema, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runTrial31, TRIAL_DAYS } from "../src/billing/index";

/** Ajuste a la prueba de 31 días (handoff trial-31 T8): una cuenta por regla. */
const DAY = 86_400_000;

describe("trial:31", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  const now = new Date();
  const ago = (d: number) => new Date(now.getTime() - d * DAY);
  const ids: Record<string, string> = {};
  let n = 0;

  async function tenant(
    name: string,
    set: Partial<typeof schema.tenant.$inferInsert>,
    extra?: (tx: Parameters<Parameters<typeof withTenant>[2]>[0], id: string) => Promise<unknown>,
  ) {
    n += 1;
    const id = await seedTenant(t.db, {
      name,
      businessType: "food",
      ownerPhone: `58412000${String(n).padStart(4, "0")}`,
    });
    ids[name] = id;
    await withTenant(t.db, id, async (tx) => {
      await tx.update(schema.tenant).set(set).where(eq(schema.tenant.id, id));
      if (extra) await extra(tx, id);
    });
  }
  const suspendAudit =
    (action: string) => (tx: Parameters<Parameters<typeof withTenant>[2]>[0], id: string) =>
      tx.insert(schema.auditLog).values({
        tenantId: id,
        actorType: action === "suspend" ? "user" : "system",
        action,
        entity: "tenant",
        entityId: id,
        after: { status: "suspended" },
        channel: action === "suspend" ? "admin" : "system",
        createdAt: ago(5),
      });
  const row = async (name: string) =>
    (
      await withTenant(t.db, ids[name] as string, (tx) =>
        tx
          .select()
          .from(schema.tenant)
          .where(eq(schema.tenant.id, ids[name] as string)),
      )
    )[0];
  const extends_ = async () =>
    (await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "extend"))).length;

  beforeAll(async () => {
    t = await createTestDb();
    // a. En la papelera.
    await tenant("borrado", { createdAt: ago(5), trialEndsAt: ago(-9), deletedAt: ago(1) });
    // b. Pagado.
    await tenant("pagado", { createdAt: ago(5), status: "active", paidUntil: ago(-25) });
    // c. Más de 31 días desde el registro.
    await tenant("viejo", { createdAt: ago(40), trialEndsAt: ago(26), status: "suspended" });
    // d. Ya extendido a mano más allá del día 31.
    await tenant("extendido", { createdAt: ago(5), trialEndsAt: ago(-40) });
    // e. Agotó la red de seguridad en dólares y luego venció: no se reabre (A3).
    await tenant(
      "agotado",
      { createdAt: ago(20), trialEndsAt: ago(6), status: "suspended", trialBudgetUsd: "0.50" },
      async (tx, id) => {
        const [p] = await tx.select().from(schema.phoneNumber);
        await tx.insert(schema.message).values({
          tenantId: id,
          phoneId: p?.id ?? "",
          direction: "out",
          kind: "text",
          body: "x",
          costUsd: "1.00",
          createdAt: ago(10),
        });
        await suspendAudit("suspend_expired")(tx, id);
      },
    );
    // f. Suspendido por vencimiento (se reabre) y a mano (no).
    await tenant(
      "suspendido_vencio",
      { createdAt: ago(20), trialEndsAt: ago(6), status: "suspended", suspendedAt: ago(3) },
      suspendAudit("suspend_expired"),
    );
    await tenant(
      "suspendido_a_mano",
      { createdAt: ago(10), trialEndsAt: ago(-4), status: "suspended" },
      suspendAudit("suspend"),
    );
    // g. En curso.
    await tenant("en_curso", { createdAt: ago(5), trialEndsAt: ago(-9), crmTags: ["Interna"] });
    // h. En gracia.
    await tenant("en_gracia", { createdAt: ago(15), trialEndsAt: ago(1) });
  });
  afterAll(() => t.close());

  it("dry-run: cuenta cada regla y no escribe", async () => {
    const c = await runTrial31(t.db, { now, apply: false });
    expect(c.sin_cambio_borrado.total).toBe(1);
    expect(c.sin_cambio_pagado.total).toBe(1);
    expect(c.sin_cambio_mas_de_31_dias.total).toBe(1);
    expect(c.sin_cambio_ya_tiene_31.total).toBe(1);
    expect(c.sin_cambio_tope_de_mensajes.total).toBe(1);
    expect(c.reabrir_suspendido.total).toBe(1);
    expect(c.sin_cambio_suspendido_a_mano.total).toBe(1);
    expect(c.extender_en_curso).toEqual({ total: 1, internal: 1 });
    expect(c.extender_en_gracia.total).toBe(1);
    expect(await extends_()).toBe(0);
    expect((await row("en_curso"))?.trialEndsAt?.getTime()).toBe(ago(-9).getTime());
  });

  it("--apply: solo extiende y reabre lo que corresponde, con un audit `extend` por cambio", async () => {
    await runTrial31(t.db, { now, apply: true });
    expect(await extends_()).toBe(3);
    for (const name of ["en_curso", "en_gracia", "suspendido_vencio"]) {
      const r = await row(name);
      expect(r?.status, name).toBe("trial");
      expect(r?.trialEndsAt?.getTime(), name).toBe(
        (r?.createdAt.getTime() ?? 0) + TRIAL_DAYS * DAY,
      );
    }
    expect((await row("suspendido_vencio"))?.suspendedAt).toBeNull();
    expect((await row("suspendido_a_mano"))?.status).toBe("suspended");
    expect((await row("agotado"))?.status).toBe("suspended");
    expect((await row("extendido"))?.trialEndsAt?.getTime()).toBe(ago(-40).getTime());
    const [a] = await t.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "extend"));
    expect(a).toMatchObject({ actorType: "system", channel: "system", entity: "tenant" });
  });

  it("es idempotente: la segunda corrida no cambia nada", async () => {
    const c = await runTrial31(t.db, { now, apply: true });
    expect(
      c.extender_en_curso.total + c.extender_en_gracia.total + c.reabrir_suspendido.total,
    ).toBe(0);
    expect(c.sin_cambio_ya_tiene_31.total).toBe(4);
    expect(await extends_()).toBe(3);
  });
});
