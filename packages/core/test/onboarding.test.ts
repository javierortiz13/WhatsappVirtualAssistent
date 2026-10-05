import { randomUUID } from "node:crypto";
import { eq, schema, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient } from "../src/agent/llm";
import { createAgent } from "../src/agent/loop";
import { Decimal } from "../src/domain/money";
import { resolveSender } from "../src/identity/resolve";
import { ingestWebhook } from "../src/inbox/ingest";
import { type ProcessDeps, processInbound } from "../src/inbox/process";
import {
  addEmployee,
  CODE_MAX_ATTEMPTS,
  CODE_TTL_MS,
  issueCode,
  onboardingCategories,
  ownerPhone,
  PhoneTakenError,
  registerBusiness,
  setPhoneStatus,
  tenantPhones,
} from "../src/onboarding/register";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/** Onboarding de punta a punta (US-A1, US-A2, US-A4): registro en el dashboard y código por WhatsApp. */
type Sent = { to: string; body: Record<string, unknown> };
const OWNER = "584241112233";
const EMPLOYEE = "584249998877";
const USER_ID = randomUUID();

function fakeMeta() {
  const sent: Sent[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (body.status !== "read") sent.push({ to: String(body.to), body });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT.${Math.random()}` }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    sent,
    client: new MetaClient({ accessToken: "T", phoneNumberId: fx.PHONE_NUMBER_ID, fetchImpl }),
  };
}

const textOf = (s: Sent | undefined) =>
  String(
    (s?.body.text as { body?: string } | undefined)?.body ??
      (s?.body.interactive as { body?: { text?: string } } | undefined)?.body?.text ??
      "",
  );

const llm: LlmClient = {
  model: "fake",
  async complete() {
    return {
      toolCalls: [{ id: "x", name: "ask_clarification", input: { question: "¿Cuánto fue?" } }],
      text: null,
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: "fake",
    };
  },
  costUsd: () => new Decimal(0),
};

describe("onboarding por código de vinculación", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let clock = new Date("2026-09-30T14:00:00Z");
  const now = () => clock;
  const jobs: ProcessMessageJob[] = [];
  let seq = 0;

  beforeAll(async () => {
    t = await createTestDb();
    await t.db.insert(schema.userAccount).values({ id: USER_ID, email: "dueno@ejemplo.com" });
    await t.db
      .insert(schema.bcvRate)
      .values({ effectiveDate: "2026-09-30", rate: "858.00000000", source: "test" });
  });
  afterAll(() => t.close());

  function deps(client: MetaClient): ProcessDeps {
    return {
      db: t.db,
      metaFor: () => client,
      agent: createAgent({ llm, now }),
      now,
      config: {
        assistantName: "Asistente de Caja",
        dashboardUrl: "https://caja.test",
        supportHint: null,
        unknownReplyMax: 5,
        unknownReplyWindowMs: 3_600_000,
        maxEventAgeMs: 12 * 3_600_000,
        maxTextLength: 500,
      },
    };
  }

  async function send(client: MetaClient, from: string, body: string, name = "Javier") {
    jobs.length = 0;
    const p = JSON.parse(JSON.stringify(fx.textMessage(`wamid.OB${++seq}`, body)));
    const value = p.entry[0].changes[0].value;
    value.contacts[0] = { profile: { name }, wa_id: from };
    value.messages[0].from = from;
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    return processInbound(deps(client), jobs[0] as ProcessMessageJob);
  }

  let tenantId: string;
  let phoneId: string;
  let code: string;

  it("registra el negocio: tenant en prueba, categorías, membresía, número del dueño pendiente y código", async () => {
    const r = await registerBusiness(
      t.db,
      {
        userId: USER_ID,
        name: "Autolavado El Rápido",
        businessType: "car_wash",
        defaultExpenseCurrency: "USD",
        ownerPhone: OWNER,
      },
      now(),
    );
    tenantId = r.tenantId;
    phoneId = r.phoneId;
    code = r.code;
    expect(code).toMatch(/^\d{6}$/);
    expect(r.expiresAt.getTime()).toBe(now().getTime() + CODE_TTL_MS);
    const resolved = await resolveSender(t.db, { e164: OWNER, waUserId: null, displayName: null });
    expect(resolved).toMatchObject({ tenantId, role: "owner", phoneStatus: "pending" });
    const cats = await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.category));
    expect(cats.length).toBeGreaterThan(3);
    const members = await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.tenantMember));
    expect(members).toEqual([expect.objectContaining({ userId: USER_ID, role: "owner" })]);
  });

  it("el mismo número no puede registrar otro negocio", async () => {
    await expect(
      registerBusiness(t.db, {
        userId: USER_ID,
        name: "Otro",
        businessType: "other",
        defaultExpenseCurrency: "VES",
        ownerPhone: OWNER,
      }),
    ).rejects.toBeInstanceOf(PhoneTakenError);
  });

  it("número pendiente sin código: pide el código y no usa el LLM", async () => {
    const { sent, client } = fakeMeta();
    expect(await send(client, OWNER, "hola")).toBe("ignored");
    expect(textOf(sent[0])).toBe(
      "Para activar este número, envíame el código de 6 dígitos que ves en https://caja.test/registro",
    );
  });

  it("código incorrecto tres veces: no coincide, luego vencido", async () => {
    const { sent, client } = fakeMeta();
    const wrong = code === "000000" ? "000001" : "000000";
    for (let i = 1; i < CODE_MAX_ATTEMPTS; i++) {
      await send(client, OWNER, wrong);
      expect(textOf(sent[i - 1])).toContain("Ese código no coincide");
    }
    await send(client, OWNER, wrong);
    expect(textOf(sent[CODE_MAX_ATTEMPTS - 1])).toContain("Ese código ya venció o se agotaron");
    // El código bueno ya no sirve.
    await send(client, OWNER, code);
    expect(textOf(sent[CODE_MAX_ATTEMPTS])).toContain("Ese código ya venció");
    expect(await ownerPhone(t.db, tenantId)).toMatchObject({ status: "pending" });
  });

  it("un código nuevo vence al anterior y el correcto activa el número con la bienvenida", async () => {
    const issued = await withTenant(t.db, tenantId, (tx) =>
      issueCode(tx, { tenantId, phoneId }, now()),
    );
    const { sent, client } = fakeMeta();
    expect(await send(client, OWNER, ` ${issued.code} `)).toBe("done");
    const body = textOf(sent[0]);
    expect(body).toContain("✅ Listo, tu número quedó vinculado a *Autolavado El Rápido*.");
    expect(body).toContain("Soy *Asistente de Caja*");
    expect(body).toContain("Tasa BCV hoy: *Bs 858,00*");
    const phone = await ownerPhone(t.db, tenantId);
    expect(phone).toMatchObject({ status: "active", e164: OWNER });
    expect(phone?.verifiedAt).not.toBeNull();
    // Ahora entra al flujo normal.
    const again = fakeMeta();
    expect(await send(again.client, OWNER, "hola")).toBe("done");
    expect(textOf(again.sent[0])).toContain("¿Qué quieres hacer?");
  });

  it("el código vence a los 15 minutos", async () => {
    const other = await registerBusiness(
      t.db,
      {
        userId: USER_ID,
        name: "Segundo",
        businessType: "food",
        defaultExpenseCurrency: "USD",
        ownerPhone: "584240000001",
      },
      now(),
    );
    const before = clock;
    clock = new Date(before.getTime() + CODE_TTL_MS + 1000);
    const { sent, client } = fakeMeta();
    await send(client, "584240000001", other.code);
    expect(textOf(sent[0])).toContain("Ese código ya venció");
    clock = before;
  });

  it("empleado agregado desde el dashboard: su primer mensaje lo activa y recibe la bienvenida", async () => {
    const r = await addEmployee(
      t.db,
      { tenantId, userId: USER_ID },
      { e164: EMPLOYEE, displayName: "Carlos" },
      now(),
    );
    expect(r.created).toBe(true);
    const { sent, client } = fakeMeta();
    expect(await send(client, EMPLOYEE, "hola", "Carlos M")).toBe("done");
    // Un solo envío: bienvenida + menú con la tasa (ADR-014).
    expect(sent).toHaveLength(1);
    expect(textOf(sent[0])).toContain(
      "Hola, Carlos. Quedaste registrado como empleado de *Autolavado El Rápido*. Puedes registrar gastos y ventas; los cierres los ve el dueño.\nEjemplo: _gasté 5$ en hielo_\n\nTasa BCV hoy:",
    );
    expect(textOf(sent[0])).toContain("¿Qué quieres hacer?");
    expect(sent[0]?.body.type).toBe("interactive");
    const again = fakeMeta();
    await send(again.client, EMPLOYEE, "hola");
    expect(again.sent).toHaveLength(1);
    const list = await withTenant(t.db, tenantId, (tx) => tenantPhones(tx, tenantId));
    expect(list.map((p) => [p.role, p.status])).toEqual([
      ["owner", "active"],
      ["employee", "active"],
    ]);
  });

  it("un empleado desactivado recibe el trato de desconocido; el dueño no se desactiva desde aquí", async () => {
    const list = await withTenant(t.db, tenantId, (tx) => tenantPhones(tx, tenantId));
    const emp = list.find((p) => p.role === "employee");
    const own = list.find((p) => p.role === "owner");
    expect(
      await setPhoneStatus(t.db, { tenantId, userId: USER_ID }, emp?.id as string, "disabled"),
    ).toBe(true);
    expect(
      await setPhoneStatus(t.db, { tenantId, userId: USER_ID }, own?.id as string, "disabled"),
    ).toBe(false);
    const { sent, client } = fakeMeta();
    expect(await send(client, EMPLOYEE, "gasté 5$ en hielo")).toBe("ignored");
    expect(textOf(sent[0])).toContain("Este número no está registrado");
    // Reactivar no repite la bienvenida.
    await setPhoneStatus(t.db, { tenantId, userId: USER_ID }, emp?.id as string, "active");
    const again = fakeMeta();
    await send(again.client, EMPLOYEE, "hola");
    expect(again.sent).toHaveLength(1);
  });

  it("el número de un empleado no puede ser el dueño de otro negocio, ni ir a dos negocios", async () => {
    await expect(
      registerBusiness(t.db, {
        userId: USER_ID,
        name: "Tercero",
        businessType: "other",
        defaultExpenseCurrency: "USD",
        ownerPhone: EMPLOYEE,
      }),
    ).rejects.toBeInstanceOf(PhoneTakenError);
    const other = await registerBusiness(t.db, {
      userId: USER_ID,
      name: "Cuarto",
      businessType: "retail",
      defaultExpenseCurrency: "USD",
      ownerPhone: "584240000002",
    });
    await expect(
      addEmployee(
        t.db,
        { tenantId: other.tenantId, userId: USER_ID },
        { e164: EMPLOYEE, displayName: null },
      ),
    ).rejects.toBeInstanceOf(PhoneTakenError);
  });

  it("onboarding: plan Personal, categorías elegidas y cuentas iniciales", async () => {
    await t.db
      .insert(schema.bcvRate)
      .values({ effectiveDate: "2026-09-28", rate: "858.00000000", source: "test" })
      .onConflictDoNothing();
    const r = await registerBusiness(
      t.db,
      {
        userId: USER_ID,
        name: "Javier",
        businessType: "personal",
        defaultExpenseCurrency: "VES",
        ownerPhone: "584240000777",
        plan: "personal",
        categories: ["Mercado", "mercado", "Gasolina", "Otros", "Mascotas"],
        accounts: [
          { name: "Banesco", currency: "VES", kind: "bank", openingBalance: "8580" },
          { name: "Binance", currency: "USD", kind: "crypto", openingBalance: "50" },
        ],
      },
      now(),
    );
    const [tenant] = await withTenant(t.db, r.tenantId, (tx) =>
      tx.select().from(schema.tenant).where(eq(schema.tenant.id, r.tenantId)),
    );
    expect(tenant).toMatchObject({ plan: "personal", businessType: "personal", status: "trial" });
    const cats = await withTenant(t.db, r.tenantId, (tx) =>
      tx
        .select()
        .from(schema.category)
        .where(eq(schema.category.tenantId, r.tenantId))
        .orderBy(schema.category.sortOrder),
    );
    expect(cats.map((c) => c.name)).toEqual(["Mercado", "Gasolina", "Mascotas", "Otros"]);
    const accounts = await withTenant(t.db, r.tenantId, (tx) =>
      tx.select().from(schema.account).where(eq(schema.account.tenantId, r.tenantId)),
    );
    expect(accounts.map((a) => [a.name, a.openingBalance])).toEqual([
      ["Banesco", "8580.00"],
      ["Binance", "50.00"],
    ]);
  });

  it("las categorías del onboarding: máximo 10 con Otros al final", () => {
    const many = Array.from({ length: 14 }, (_, i) => `Cat ${i}`);
    const out = onboardingCategories(many, "other");
    expect(out).toHaveLength(10);
    expect(out.at(-1)).toBe("Otros");
    expect(onboardingCategories(undefined, "personal")).toContain("Comida fuera");
  });
});
