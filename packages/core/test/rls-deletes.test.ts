import { randomUUID } from "node:crypto";
import { eq, schema, sql, type Tx } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeDashboardMember } from "../src/onboarding/chat-signup";
import { LEFT_PREFIX, releaseEmployeePhone } from "../src/onboarding/register";

/**
 * Seguridad N4: los borrados nuevos (GRANT DELETE de 0033) probados como `caja_app`, con RLS de
 * verdad. El resto de las pruebas corre como superusuario, que se salta RLS y los permisos.
 */
describe("borrados como caja_app (N4)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let a = "";
  let b = "";
  const owner = randomUUID();
  const member = randomUUID();
  const other = randomUUID();

  /** Una transacción como la app: rol `caja_app` y el negocio de la sesión. */
  const asApp = <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) =>
    t.db.transaction(async (tx) => {
      await tx.execute(sql`set local role caja_app`);
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      return fn(tx);
    });
  const employee = async (tenantId: string, e164: string) => {
    const [r] = await t.db
      .insert(schema.phoneNumber)
      .values({ tenantId, e164, role: "employee", status: "pending" })
      .returning({ id: schema.phoneNumber.id });
    return r?.id ?? "";
  };
  const phoneRow = async (id: string) =>
    (await t.db.select().from(schema.phoneNumber).where(eq(schema.phoneNumber.id, id)))[0];
  const members = async (tenantId: string) =>
    (
      await t.db
        .select({ userId: schema.tenantMember.userId })
        .from(schema.tenantMember)
        .where(eq(schema.tenantMember.tenantId, tenantId))
    ).map((m) => m.userId);

  beforeAll(async () => {
    t = await createTestDb();
    a = await seedTenant(t.db, { name: "A", businessType: "food", ownerPhone: "584121000001" });
    b = await seedTenant(t.db, { name: "B", businessType: "food", ownerPhone: "584121000002" });
    await t.db.insert(schema.userAccount).values([
      { id: owner, email: "duena@a.com" },
      { id: member, email: "socio@a.com" },
      { id: other, email: "dueno@b.com" },
    ]);
    await t.db.insert(schema.tenantMember).values([
      { tenantId: a, userId: owner },
      { tenantId: a, userId: member },
      { tenantId: b, userId: other },
    ]);
  });
  afterAll(() => t.close());

  it("«Quitar acceso» borra en su negocio; apuntado a otro negocio, 0 filas", async () => {
    expect(
      await asApp(a, (tx) =>
        removeDashboardMember(tx, { tenantId: a, actorUserId: owner }, member),
      ),
    ).toBe(true);
    expect(await members(a)).toEqual([owner]);
    // Desde la sesión de A, el miembro de B no se ve ni se borra.
    expect(
      await asApp(a, (tx) => removeDashboardMember(tx, { tenantId: b, actorUserId: owner }, other)),
    ).toBe(false);
    const raw = await asApp(a, (tx) =>
      tx
        .delete(schema.tenantMember)
        .where(eq(schema.tenantMember.tenantId, b))
        .returning({ id: schema.tenantMember.userId }),
    );
    expect(raw).toEqual([]);
    expect(await members(b)).toEqual([other]);
  });

  it("«No trabajo ahí» borra la fila de verdad (no el respaldo salio:); otro negocio, 0 filas", async () => {
    const mine = await employee(a, "584161000001");
    const theirs = await employee(b, "584161000002");
    expect(
      await asApp(a, (tx) =>
        releaseEmployeePhone(tx, { tenantId: a, phoneId: mine }, "employee_declined"),
      ),
    ).toBe(true);
    // Borrada: sin el GRANT, el código cae a `salio:<id>` y escondería el problema.
    expect(await phoneRow(mine)).toBeUndefined();
    expect(
      await asApp(a, (tx) =>
        releaseEmployeePhone(tx, { tenantId: b, phoneId: theirs }, "employee_declined"),
      ),
    ).toBe(false);
    const raw = await asApp(a, (tx) =>
      tx
        .delete(schema.phoneNumber)
        .where(eq(schema.phoneNumber.id, theirs))
        .returning({ id: schema.phoneNumber.id }),
    );
    expect(raw).toEqual([]);
    expect((await phoneRow(theirs))?.e164).toBe("584161000002");
  });

  it("sin el GRANT DELETE la prueba lo nota: «Quitar acceso» falla y el empleado queda en salio:", async () => {
    await t.db.insert(schema.tenantMember).values({ tenantId: a, userId: member });
    const mine = await employee(a, "584161000003");
    await expect(
      t.db.transaction(async (tx) => {
        await tx.execute(sql`revoke delete on app.tenant_member from caja_app`);
        await tx.execute(sql`set local role caja_app`);
        await tx.execute(sql`select set_config('app.tenant_id', ${a}, true)`);
        await removeDashboardMember(tx, { tenantId: a, actorUserId: owner }, member);
      }),
    ).rejects.toThrow();
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`revoke delete on app.phone_number from caja_app`);
      await tx.execute(sql`set local role caja_app`);
      await tx.execute(sql`select set_config('app.tenant_id', ${a}, true)`);
      await releaseEmployeePhone(tx, { tenantId: a, phoneId: mine }, "employee_declined");
    });
    // Es la última prueba: el revoke de phone_number quedó confirmado en esta base.
    expect((await phoneRow(mine))?.e164).toBe(`${LEFT_PREFIX}${mine}`);
  });
});
