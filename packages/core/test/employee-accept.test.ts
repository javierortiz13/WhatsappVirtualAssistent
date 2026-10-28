import { eq, schema, withTenant } from "@caja/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addEmployee,
  EmployeeLimitError,
  LEFT_PREFIX,
  phoneIsTaken,
  setPhoneStatus,
} from "../src/onboarding/register";
import { botHarness, CASHIER, idsOf, OWNER, textOf } from "./bot-harness";

/** Seguridad F1: el empleado acepta o no; puede salir; tope de empleados por plan. */
const NEW = "584161112222";
const USER = "66666666-6666-4666-8666-666666666666";

describe("empleados: aceptar, no aceptar y salir (F1)", () => {
  let h: Awaited<ReturnType<typeof botHarness>>;
  const ref = () => ({ tenantId: h.tenantId, userId: USER });
  const phone = async (e164: string) =>
    (await h.t.db.select().from(schema.phoneNumber).where(eq(schema.phoneNumber.e164, e164)))[0];
  const setPlan = (plan: string) =>
    h.t.db.update(schema.tenant).set({ plan }).where(eq(schema.tenant.id, h.tenantId));

  beforeAll(async () => {
    h = await botHarness();
    await h.t.db.insert(schema.userAccount).values({ id: USER, email: "ana@ejemplo.com" });
  });
  afterAll(() => h.t.close());

  it("tope del plan: Negocio admite 1 empleado (ya está la cajera); Negocio Plus, 3", async () => {
    await setPlan("negocio");
    await expect(
      addEmployee(h.t.db, ref(), { e164: NEW, displayName: "Luis" }),
    ).rejects.toBeInstanceOf(EmployeeLimitError);
    await setPlan("personal");
    await expect(
      addEmployee(h.t.db, ref(), { e164: NEW, displayName: "Luis" }),
    ).rejects.toBeInstanceOf(EmployeeLimitError);
    await setPlan("negocio_plus");
    const r = await addEmployee(h.t.db, ref(), { e164: NEW, displayName: "Luis" });
    expect((await phone(NEW))?.status).toBe("pending");
    // Reactivar a quien nunca aceptó lo deja pendiente.
    await setPhoneStatus(h.t.db, ref(), r.phoneId, "disabled");
    await setPhoneStatus(h.t.db, ref(), r.phoneId, "active");
    expect((await phone(NEW))?.status).toBe("pending");
  });

  it("«No soy de ahí»: el número queda libre y el dueño recibe el aviso si su ventana está abierta", async () => {
    await h.send("hola"); // abre la ventana del dueño
    const p = await phone(NEW);
    await h.send("gasté 20$ en farmacia", NEW);
    expect(idsOf(h.last(NEW))).toEqual([`emp:join:${p?.id}`, `emp:no:${p?.id}`]);
    const body = await h.tap(`emp:no:${p?.id}`, "No soy de ahí", NEW);
    expect(body).toContain("Tu número quedó libre");
    expect(await phone(NEW)).toBeUndefined();
    expect(await phoneIsTaken(h.t.db, NEW)).toBe(false);
    expect(textOf(h.last(OWNER))).toBe(
      "+58…2222 no aceptó unirse a tu negocio. Su número ya no está en tu cuenta.",
    );
    const [a] = await withTenant(h.t.db, h.tenantId, (tx) =>
      tx.select().from(schema.auditLog).where(eq(schema.auditLog.action, "employee_declined")),
    );
    expect(a?.before).toEqual({ status: "pending", e164: "2222" });
  });

  it("«salir del negocio» con confirmación: lo anotado se queda, el número queda libre", async () => {
    const before = await phone(CASHIER);
    await h.t.db.insert(schema.message).values({
      tenantId: h.tenantId,
      phoneId: before?.id ?? "",
      direction: "in",
      kind: "text",
      body: "historial",
    });
    expect(await h.send("Salir del negocio", CASHIER)).toContain("¿Salir de *Ana*?");
    expect(idsOf(h.last(CASHIER))).toEqual([`emp:leave:${before?.id}`, "emp:stay"]);
    // El dueño no puede salir así.
    expect(await h.send("salir del negocio")).not.toContain("¿Salir de");
    expect(await h.tap(`emp:leave:${before?.id}`, "Sí, salir", CASHIER)).toContain(
      "Listo, saliste de *Ana*.",
    );
    const [kept] = await h.t.db
      .select()
      .from(schema.phoneNumber)
      .where(eq(schema.phoneNumber.id, before?.id ?? ""));
    expect(kept?.e164).toBe(`${LEFT_PREFIX}${before?.id}`);
    expect(kept?.status).toBe("disabled");
    expect(await phoneIsTaken(h.t.db, CASHIER)).toBe(false);
    expect(textOf(h.last(OWNER))).toBe(
      "+58…6543 salió de tu negocio. Lo que anotó se queda en tu cuenta.",
    );
    // No se puede reactivar a quien salió.
    expect(await setPhoneStatus(h.t.db, ref(), before?.id ?? "", "active")).toBe(false);
  });
});
