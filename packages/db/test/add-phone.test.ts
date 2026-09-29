import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rows, sql } from "../src/index";
import { addPhone } from "../src/seed/add-phone";
import { seedTenant } from "../src/seed/index";
import { createTestDb } from "../src/testing/pglite";

describe("alta de teléfonos por CLI", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Autolavado",
      businessType: "car_wash",
      ownerPhone: "17869660391",
    });
    await seedTenant(t.db, { name: "Otro", businessType: "food", ownerPhone: "584120000001" });
  });
  afterAll(() => t.close());

  const resolve = async (e164: string) =>
    rows<{ tenant_id: string; role: string; status: string }>(
      await t.db.execute(sql`select * from app.resolve_phone(${e164}, null)`),
    )[0];

  it("crea un empleado activo en el negocio del dueño y es idempotente", async () => {
    const r = await addPhone(t.db, {
      owner: "17869660391",
      phone: "584141234567",
      role: "employee",
      name: "Carlos",
    });
    expect(r).toMatchObject({ tenantId, created: true });
    expect(await resolve("584141234567")).toMatchObject({
      tenant_id: tenantId,
      role: "employee",
      status: "active",
    });
    const again = await addPhone(t.db, {
      owner: "17869660391",
      phone: "584141234567",
      role: "employee",
      name: "Carlos R.",
    });
    expect(again.created).toBe(false);
    expect((await resolve("584141234567"))?.role).toBe("employee");
  });

  it("rechaza dueños inexistentes, no dueños y números de otro negocio", async () => {
    await expect(
      addPhone(t.db, { owner: "580000000000", phone: "584140000009", role: "employee" }),
    ).rejects.toThrow(/ningún negocio/);
    await expect(
      addPhone(t.db, { owner: "584141234567", phone: "584140000009", role: "employee" }),
    ).rejects.toThrow(/no es de un dueño/);
    await expect(
      addPhone(t.db, { owner: "17869660391", phone: "584120000001", role: "employee" }),
    ).rejects.toThrow(/otro negocio/);
  });
});
