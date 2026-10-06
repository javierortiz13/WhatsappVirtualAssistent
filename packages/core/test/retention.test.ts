import { eq, schema, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setTenantBilling } from "../src/billing/payments";
import { retentionSweep, unpaidTrashDate } from "../src/billing/retention";
import { requestDeletion, restoreTenant } from "../src/onboarding/erase";
import { MemoryObjectStore } from "../src/storage/index";

const DAY = 24 * 60 * 60 * 1000;

/** Cuánto se guardan los datos (0017): 90 días suspendido con avisos, 15 en la papelera. */
describe("retención de datos", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let unpaid: string;
  let active: string;
  const t0 = new Date("2026-10-06T15:00:00Z");
  const at = (days: number) => new Date(t0.getTime() + days * DAY);
  const tenant = async (id: string) =>
    withTenant(t.db, id, async (tx) => {
      const [r] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, id));
      return r;
    });

  beforeAll(async () => {
    t = await createTestDb();
    unpaid = await seedTenant(t.db, {
      name: "Impago",
      businessType: "food",
      ownerPhone: "584121110001",
    });
    active = await seedTenant(t.db, {
      name: "Al día",
      businessType: "food",
      ownerPhone: "584121110002",
    });
    const before = await tenant(unpaid);
    if (!before) throw new Error("sin tenant");
    await withTenant(t.db, unpaid, (tx) =>
      setTenantBilling(tx, before, { status: "suspended" }, null, t0, "suspend_expired"),
    );
  });
  afterAll(() => t.close());

  it("suspender guarda la fecha; reactivar la borra", async () => {
    expect((await tenant(unpaid))?.suspendedAt?.getTime()).toBe(t0.getTime());
    expect(unpaidTrashDate(t0).getTime()).toBe(at(90).getTime());
  });

  it("avisa a los 60 y 83 días, una vez cada uno; a los 90 pasa a la papelera; a los 15 se borra", async () => {
    expect((await retentionSweep(t.db, at(59))).notices).toEqual([]);
    const n60 = await retentionSweep(t.db, at(60));
    expect(n60.notices.map((n) => [n.tenantName, n.level])).toEqual([["Impago", 1]]);
    expect(n60.notices[0]?.owner?.e164).toBe("584121110001");
    expect(n60.notices[0]?.trashOn.getTime()).toBe(at(90).getTime());
    expect((await retentionSweep(t.db, at(61))).notices).toEqual([]);
    expect((await retentionSweep(t.db, at(83))).notices.map((n) => n.level)).toEqual([2]);

    const s90 = await retentionSweep(t.db, at(90));
    expect(s90.trashed).toEqual([unpaid]);
    const trashed = await tenant(unpaid);
    expect(trashed?.deletionReason).toBe("unpaid");
    expect(trashed?.purgeAfter?.getTime()).toBe(at(105).getTime());

    expect((await retentionSweep(t.db, at(104))).purged).toEqual([]);
    const store = new MemoryObjectStore();
    const s105 = await retentionSweep(t.db, at(105), { store });
    expect(s105.purged).toEqual([unpaid]);
    expect(await tenant(unpaid)).toBeUndefined();
    expect(await tenant(active)).toBeDefined();
  });

  it("recuperar de la papelera: si entró por impago sigue suspendido y vuelven a contar los 90 días", async () => {
    const now = at(1);
    await withTenant(t.db, active, (tx) =>
      requestDeletion(tx, {
        tenantId: active,
        reason: "unpaid",
        actor: { type: "system" },
        channel: "system",
        now,
      }),
    );
    expect(
      await withTenant(t.db, active, (tx) =>
        restoreTenant(tx, {
          tenantId: active,
          actor: { type: "system" },
          channel: "admin",
          now: at(2),
        }),
      ),
    ).toBe(true);
    const back = await tenant(active);
    expect(back?.deletedAt).toBeNull();
    expect(back?.suspendedAt?.getTime()).toBe(at(2).getTime());
    // Ya no estaba en la papelera.
    expect(
      await withTenant(t.db, active, (tx) =>
        restoreTenant(tx, {
          tenantId: active,
          actor: { type: "system" },
          channel: "admin",
          now: at(3),
        }),
      ),
    ).toBe(false);
  });
});
