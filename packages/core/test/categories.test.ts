import { randomUUID } from "node:crypto";
import { schema, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CategoryError,
  createCategory,
  getTenantSettings,
  listCategories,
  renameCategory,
  setCategoryActive,
  updateTenantSettings,
} from "../src/ledger/categories";

describe("categorías y configuración desde el dashboard", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  const userId = randomUUID();
  const ref = () => ({ tenantId, userId });

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Autolavado",
      businessType: "car_wash",
      ownerPhone: "584121234567",
    });
    await t.db.insert(schema.userAccount).values({ id: userId, email: "d@x.com" });
  });
  afterAll(() => t.close());

  it("cuenta los gastos vivos de cada categoría", async () => {
    await withTenant(t.db, tenantId, async (tx) => {
      const [cat] = await listCategories(tx, tenantId);
      if (!cat) throw new Error("sin categorías");
      const [phone] = await tx.select().from(schema.phoneNumber);
      const [rate] = await tx
        .insert(schema.bcvRate)
        .values({ effectiveDate: "2026-09-29", rate: "858.00000000", source: "test" })
        .returning();
      const base = {
        tenantId,
        type: "expense",
        businessDate: "2026-09-29",
        amount: "15.00",
        currency: "USD",
        rateId: rate?.id,
        rateValue: "858.00000000",
        amountUsd: "15.00",
        amountVes: "12870.00",
        sourceChannel: "text",
        createdByPhoneId: phone?.id,
        categoryId: cat.id,
      } as const;
      await tx.insert(schema.movement).values([base, base, { ...base, deletedAt: new Date() }]);
      const list = await listCategories(tx, tenantId);
      expect(list.find((c) => c.id === cat.id)?.movements).toBe(2);
      expect(list.filter((c) => c.id !== cat.id).every((c) => c.movements === 0)).toBe(true);
    });
  });

  it("crea, renombra y desactiva; rechaza duplicados sin distinguir mayúsculas", async () => {
    await withTenant(t.db, tenantId, async (tx) => {
      const before = await listCategories(tx, tenantId);
      const id = await createCategory(tx, ref(), "  Marketing digital  ");
      const after = await listCategories(tx, tenantId);
      expect(after.length).toBe(before.length + 1);
      expect(after.at(-1)).toMatchObject({
        id,
        name: "Marketing digital",
        isActive: true,
        movements: 0,
      });
      await expect(createCategory(tx, ref(), "marketing DIGITAL")).rejects.toMatchObject({
        code: "duplicate",
      });
      await expect(createCategory(tx, ref(), "x")).rejects.toBeInstanceOf(CategoryError);
      await renameCategory(tx, ref(), id, "Marketing y redes");
      await expect(renameCategory(tx, ref(), id, before[0]?.name as string)).rejects.toMatchObject({
        code: "duplicate",
      });
      await setCategoryActive(tx, ref(), id, false);
      const list = await listCategories(tx, tenantId);
      expect(list.find((c) => c.id === id)).toMatchObject({
        name: "Marketing y redes",
        isActive: false,
      });
      const audits = await tx.select().from(schema.auditLog);
      expect(
        audits.filter((a) => a.entity === "category" && a.channel === "dashboard").length,
      ).toBe(3);
    });
  });

  it("configuración del negocio: cambia nombre, tipo y moneda con auditoría; sin cambios no escribe", async () => {
    await withTenant(t.db, tenantId, async (tx) => {
      expect(await getTenantSettings(tx, tenantId)).toEqual({
        name: "Autolavado",
        businessType: "car_wash",
        defaultExpenseCurrency: "USD",
        bsRateMode: "bcv",
      });
      await updateTenantSettings(tx, ref(), {
        name: "Autolavado El Rápido",
        businessType: "services",
        defaultExpenseCurrency: "VES",
      });
      await updateTenantSettings(tx, ref(), {
        name: "Autolavado El Rápido",
        businessType: "services",
        defaultExpenseCurrency: "VES",
      });
      expect(await getTenantSettings(tx, tenantId)).toMatchObject({
        name: "Autolavado El Rápido",
        defaultExpenseCurrency: "VES",
      });
      const audits = await tx.select().from(schema.auditLog);
      expect(audits.filter((a) => a.entity === "tenant").length).toBe(1);
    });
  });
});
