import { eq, schema, withTenant } from "@caja/db";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  handleSignup,
  remainingSteps,
  type SignupInput,
  saveSignupFlowSettings,
} from "../src/onboarding/chat-signup";
import { es } from "../src/render/index";

/** Registro rápido (29/10): 2 toques en personal, 1 texto y 2 toques en negocio. */
const TEST = "584169990001";
const textOf = (o: { body?: string } | undefined) => o?.body ?? "";
const idsOf = (o: unknown) =>
  ((o as { buttons?: { id: string }[] }).buttons ?? []).map((b) => b.id);

describe("registro rápido", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let n = 0;
  const num = () => `58414555${String(++n).padStart(4, "0")}`;
  const cfg = (fast: string[] = []) => ({ dashboardUrl: "https://caja.test", fastNumbers: fast });
  const send = (
    e164: string,
    x: Partial<SignupInput>,
    fast: string[] = [e164],
    profileName: string | null = "Javier Ortiz",
  ) =>
    handleSignup(
      t.db,
      { e164, waUserId: null, profileName, text: null, replyId: null, ...x },
      cfg(fast),
      new Date(),
    );
  const row = async (e164: string) =>
    (await t.db.select().from(schema.signup).where(eq(schema.signup.e164, e164)))[0];

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await saveSignupFlowSettings(t.db, { fast: false }, "test", new Date());
  });

  it("apagado y sin número de prueba: el registro de siempre", async () => {
    const e = num();
    const r = await send(e, { text: "hola" }, []);
    expect(r.outbound).toEqual([es.signupIntro("https://caja.test", "Javier")]);
    expect((await row(e))?.step).toBe("name");
  });

  it("negocio: nombre del perfil, para qué, nombre del negocio (tipo deducido), moneda y listo", async () => {
    const e = num();
    const intro = await send(e, { text: "hola" });
    expect(textOf(intro.outbound[0])).toContain("Hola, Javier. Soy Rocco");
    expect(textOf(intro.outbound[0])).toContain("https://caja.test/privacidad");
    expect(idsOf(intro.outbound[0])).toEqual(["signup:kind:personal", "signup:kind:business"]);
    expect(await row(e)).toMatchObject({ step: "kind", data: { flow: "fast", name: "Javier" } });

    expect((await send(e, { replyId: "signup:kind:business" })).outbound).toEqual([
      es.signupFastAskBusinessName(),
    ]);
    const cur = await send(e, { text: "Autolavado El Rápido" });
    expect(cur.outbound).toEqual([es.signupFastAskCurrency(true)]);
    expect((await row(e))?.data).toMatchObject({ businessType: "car_wash" });

    const done = await send(e, { replyId: "signup:cur:USD" });
    expect(done.step).toBe("done");
    expect(done.outbound).toHaveLength(1);
    expect(textOf(done.outbound[0])).toMatch(
      /^✅ Listo, Javier\. La cuenta de \*Autolavado El Rápido\* está creada y tienes \*31 días o \d+ mensajes gratis\*/,
    );
    expect(textOf(done.outbound[0])).toContain("escríbeme un gasto");
    const tenantId = done.created?.tenantId as string;
    const cats = await withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.category).where(eq(schema.category.tenantId, tenantId)),
    );
    expect(cats.map((c) => c.name)).toContain("Insumos de lavado");
    const [tenant] = await withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId)),
    );
    expect(tenant).toMatchObject({ businessType: "car_wash", defaultExpenseCurrency: "USD" });
  });

  it("personal: dos toques", async () => {
    const e = num();
    await send(e, { text: "Buenas" });
    expect((await send(e, { replyId: "signup:kind:personal" })).outbound).toEqual([
      es.signupFastAskCurrency(false),
    ]);
    const done = await send(e, { text: "en bolívares" });
    expect(textOf(done.outbound[0])).toContain("Tu cuenta está creada");
    expect((await row(e))?.data).toMatchObject({ currency: "VES", budgets: [] });
  });

  it("sin nombre de perfil usable: pregunta el nombre y sigue", async () => {
    const e = num();
    const intro = await send(e, { text: "hola" }, [e], "🌟🌟");
    expect(textOf(intro.outbound[0])).toContain("Primero, ¿cómo te llamas?");
    const kind = await send(e, { text: "me llamo Ana" }, [e], "🌟🌟");
    expect(kind.outbound).toEqual([es.signupFastAskKind("Ana")]);
  });

  it("si el nombre del negocio no dice el tipo, sale la lista", async () => {
    const e = num();
    await send(e, { text: "hola" });
    await send(e, { replyId: "signup:kind:business" });
    const r = await send(e, { text: "Inversiones JP" });
    expect(r.outbound[0]?.type).toBe("list");
    await send(e, { replyId: "signup:type:services" });
    expect((await row(e))?.step).toBe("currency");
  });

  it("el interruptor lo enciende para todos; un registro empezado sigue con su flujo", async () => {
    const old = num();
    await send(old, { text: "hola" }, []);
    await saveSignupFlowSettings(t.db, { fast: true }, "test", new Date());
    const e = num();
    expect(textOf((await send(e, { text: "hola" }, [])).outbound[0])).toContain("Hola, Javier");
    await send(old, { text: "Javier" }, []);
    await send(old, { replyId: "signup:kind:personal" }, []);
    expect((await send(old, { replyId: "signup:cur:USD" }, [])).step).not.toBe("done");
    expect((await row(old))?.step).toBe("categories");
  });

  it("pasos que faltan sin presupuesto; el recordatorio no dice «1 pasos»", async () => {
    expect(remainingSteps("currency", { flow: "fast", kind: "personal" })).toBe(1);
    expect(remainingSteps("biz_name", { flow: "fast", kind: "business" })).toBe(3);
    expect(textOf(es.signupRescue("currency", "Ana", 1))).not.toContain("1 pasos");
    expect(textOf(es.signupRescue("currency", "Ana", 1))).toContain("Faltan unas preguntas cortas");
  });

  it("«no me escribas» en el registro rápido: la línea SR-STOP-DONE va en el mismo mensaje", async () => {
    const e = num();
    await send(e, { text: "hola" });
    await send(e, { text: "no me escribas" });
    await send(e, { replyId: "signup:kind:personal" });
    const done = await send(e, { replyId: "signup:cur:USD" });
    expect(done.outbound).toHaveLength(1);
    expect(textOf(done.outbound[0])).toContain(es.SIGNUP_STOP_DONE_LINE);
  });

  it("los números de prueba se comparan solo por dígitos", async () => {
    const r = await handleSignup(
      t.db,
      { e164: TEST, waUserId: null, profileName: "Luis", text: "hola", replyId: null },
      cfg(["+58 416-999-0001"]),
      new Date(),
    );
    expect(textOf(r.outbound[0])).toContain("Hola, Luis");
  });
});
