import { eq, schema, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient, LlmResponse } from "../src/agent/llm";
import { createAgent } from "../src/agent/loop";
import { asIsoDate } from "../src/domain/dates";
import { Decimal } from "../src/domain/money";
import { ingestWebhook } from "../src/inbox/ingest";
import { type ProcessDeps, processInbound } from "../src/inbox/process";
import { BudgetError, budgetStatuses, budgetWindow, setBudget } from "../src/ledger/budgets";
import { budgetLine, budgetsSummary } from "../src/render/es-VE";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/** Presupuestos por categoría (0009): ventanas, cálculo, auditoría y lo que dice el bot. */

describe("ventana del presupuesto", () => {
  it("mensual: mes calendario, con febrero y meses de 31", () => {
    expect(budgetWindow("monthly", asIsoDate("2026-10-03"))).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
    expect(budgetWindow("monthly", asIsoDate("2028-02-29"))).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
  });
  it("quincenal: del 1 al 15 y del 16 al fin de mes", () => {
    expect(budgetWindow("biweekly", asIsoDate("2026-10-15"))).toEqual({
      from: "2026-10-01",
      to: "2026-10-15",
    });
    expect(budgetWindow("biweekly", asIsoDate("2026-10-16"))).toEqual({
      from: "2026-10-16",
      to: "2026-10-31",
    });
    expect(budgetWindow("biweekly", asIsoDate("2026-09-30"))).toEqual({
      from: "2026-09-16",
      to: "2026-09-30",
    });
  });
});

describe("cómo se dice un presupuesto", () => {
  const today = asIsoDate("2026-10-03");
  const view = (spent: string, over: Partial<Parameters<typeof budgetLine>[0]> = {}) => {
    const amountUsd = new Decimal(200);
    const spentUsd = new Decimal(spent);
    return {
      name: "Insumos",
      period: "monthly" as const,
      amountUsd,
      remainingUsd: amountUsd.minus(spentUsd),
      pct: spentUsd.div(amountUsd).mul(100).floor().toNumber(),
      from: asIsoDate("2026-10-01"),
      to: asIsoDate("2026-10-31"),
      daysLeft: 29,
      ...over,
    };
  };
  it("lo que queda, el aviso desde el 80 %, el tope y lo pasado", () => {
    expect(budgetLine(view("155"), today)).toBe("Insumos: te quedan *$45,00* de $200,00 este mes.");
    expect(budgetLine(view("170"), today)).toBe(
      "⚠️ Insumos: vas por el 85 %. Te quedan *$30,00* de $200,00 este mes.",
    );
    expect(budgetLine(view("200"), today)).toBe(
      "🔴 Insumos: llegaste al tope de $200,00 este mes.",
    );
    expect(budgetLine(view("212"), today)).toBe(
      "🔴 Insumos: te pasaste por *$12,00* del presupuesto de $200,00 este mes.",
    );
  });
  it("un gasto de otro período lo nombra", () => {
    const sep = { from: asIsoDate("2026-09-16"), to: asIsoDate("2026-09-30") };
    expect(budgetLine(view("20", { period: "biweekly", ...sep }), today)).toBe(
      "Insumos: te quedan *$180,00* de $200,00 en la 2ª quincena de septiembre.",
    );
    expect(
      budgetLine(view("20", { from: asIsoDate("2026-09-01"), to: asIsoDate("2026-09-30") }), today),
    ).toBe("Insumos: te quedan *$180,00* de $200,00 en septiembre.");
  });
  it("el resumen de varios lleva cuánto falta para reiniciar", () => {
    const out = budgetsSummary(
      [
        view("155"),
        view("90", {
          name: "Comida",
          period: "biweekly",
          amountUsd: new Decimal(80),
          remainingUsd: new Decimal(-10),
          pct: 112,
          from: asIsoDate("2026-10-01"),
          to: asIsoDate("2026-10-15"),
          daysLeft: 13,
        }),
      ],
      today,
    );
    expect(out).toEqual({
      type: "text",
      body: "*Presupuestos* · sáb 03/10\n• Insumos: quedan *$45,00* de $200,00 (77 %)\n🔴 Comida: pasado por *$10,00* (tope $80,00 · quincenal)\n_Mes: faltan 29 días. Quincena: faltan 13 días._",
    });
  });
});

describe("presupuestos de punta a punta", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  let insumos: string;
  let comida: string;
  const ownerRef = () => ({ tenantId, userId: "11111111-1111-4111-8111-111111111111" });
  const now = () => new Date("2026-10-03T15:00:00Z");
  const jobs: ProcessMessageJob[] = [];
  let seq = 0;
  const EMPLOYEE = "584140000002";

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Autolavado",
      businessType: "car_wash",
      ownerPhone: "584121234567",
    });
    await withTenant(t.db, tenantId, async (tx) => {
      await tx.insert(schema.phoneNumber).values({
        tenantId,
        e164: EMPLOYEE,
        role: "employee",
        status: "active",
        displayName: "Carlos",
        verifiedAt: now(),
      });
      const cats = await tx.select().from(schema.category);
      insumos = cats.find((c) => c.name === "Insumos de lavado")?.id as string;
      comida = cats.find((c) => c.name === "Comida del personal")?.id as string;
    });
    await t.db.insert(schema.bcvRate).values([
      { effectiveDate: "2026-09-29", rate: "858.00000000", source: "test" },
      { effectiveDate: "2026-10-02", rate: "866.56000000", source: "test" },
    ]);
  });
  afterAll(() => t.close());

  const expense = (id: string, amount: string, description: string, category: string) => [
    {
      id,
      name: "draft_expense",
      input: {
        amount,
        currency: "USD",
        description,
        category_name: category,
        when: "",
        rate: "",
        corrects_draft: false,
      },
    },
  ];
  const budgets = (id: string, category_name = "", wants_to_set = false) => [
    { id, name: "get_budgets", input: { category_name, wants_to_set } },
  ];
  const llm: LlmClient = {
    model: "claude-sonnet-5-5",
    async complete(req) {
      const last = req.turns[req.turns.length - 1];
      const text = last && "text" in last ? (last.text ?? "") : "";
      const msg = text.split("Mensaje del usuario: ")[1] ?? "";
      const script: Record<string, LlmResponse["toolCalls"]> = {
        "cuánto me queda en insumos": budgets("b1", "insumos"),
        "cuánto me queda en publicidad": budgets("b2", "publicidad"),
        "cuánto me queda en viajes": budgets("b3", "viajes"),
        "cómo voy con los presupuestos": budgets("b4"),
        "ponle 200$ al mes a insumos": budgets("b5", "insumos", true),
        "gasté 150$ en champú": expense("e1", "150", "Champú", "Insumos de lavado"),
        "gasté 20$ en cera": expense("e2", "20", "Cera", "Insumos de lavado"),
        "gasté 10$ en arepas": expense("e3", "10", "Arepas", "Comida del personal"),
      };
      const key = Object.keys(script).find((k) => msg.includes(k));
      if (!key) throw new Error(`sin guion para: ${msg}`);
      return {
        toolCalls: script[key] ?? [],
        text: null,
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: "claude-sonnet-5-5",
      };
    },
    costUsd: () => new Decimal(0),
  };

  type Sent = { body: Record<string, unknown> };
  type Interactive = { body: { text: string }; action: { buttons: { reply: { id: string } }[] } };
  const textOf = (s: Sent | undefined) =>
    String(
      (s?.body.text as { body?: string } | undefined)?.body ??
        (s?.body.interactive as Interactive | undefined)?.body.text ??
        "",
    );
  const saveId = (s: Sent | undefined) =>
    (s?.body.interactive as Interactive | undefined)?.action.buttons[0]?.reply.id as string;

  function fakeMeta() {
    const sent: Sent[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (body.status !== "read") sent.push({ body });
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
  function deps(client: MetaClient): ProcessDeps {
    return {
      db: t.db,
      metaFor: () => client,
      agent: createAgent({ llm, now }),
      now,
      config: {
        assistantName: "x",
        dashboardUrl: "https://caja.test",
        supportHint: null,
        unknownReplyMax: 5,
        unknownReplyWindowMs: 3_600_000,
        maxEventAgeMs: 12 * 3_600_000,
        maxTextLength: 500,
        knownMax: 1000,
      },
    };
  }
  const ingest = async (payload: unknown) => {
    jobs.length = 0;
    await ingestWebhook(
      { db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) },
      payload,
    );
    return jobs[0] as ProcessMessageJob;
  };
  async function send(client: MetaClient, body: string, from = "584121234567") {
    const p = JSON.parse(JSON.stringify(fx.textMessage(`wamid.B${++seq}`, body)));
    p.entry[0].changes[0].value.messages[0].from = from;
    p.entry[0].changes[0].value.contacts[0].wa_id = from;
    return processInbound(deps(client), await ingest(p));
  }
  async function tap(client: MetaClient, id: string, from = "584121234567") {
    const p = JSON.parse(JSON.stringify(fx.buttonReply));
    p.entry[0].changes[0].value.messages[0].id = `wamid.BB${++seq}`;
    p.entry[0].changes[0].value.messages[0].from = from;
    p.entry[0].changes[0].value.messages[0].interactive.button_reply = { id, title: "Guardar" };
    return processInbound(deps(client), await ingest(p));
  }

  it("sin presupuestos lo dice y manda al dashboard; ponerlo por chat también", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "cómo voy con los presupuestos");
    expect(textOf(sent[0])).toBe(
      "Todavía no tienes presupuestos. Ponlos en https://caja.test/ajustes/categorias: a cada categoría le das un tope en dólares, mensual o quincenal.",
    );
    await send(client, "ponle 200$ al mes a insumos");
    expect(textOf(sent[1])).toContain("Los presupuestos se ponen en el dashboard");
  });

  it("setBudget crea, cambia y quita con auditoría; rechaza montos y categorías ajenas", async () => {
    await withTenant(t.db, tenantId, async (tx) => {
      await setBudget(tx, ownerRef(), {
        categoryId: insumos,
        amountUsd: new Decimal(150),
        period: "biweekly",
      });
      await setBudget(tx, ownerRef(), {
        categoryId: insumos,
        amountUsd: new Decimal("200"),
        period: "monthly",
      });
      // Igual que antes: no deja auditoría de más.
      await setBudget(tx, ownerRef(), {
        categoryId: insumos,
        amountUsd: new Decimal("200.00"),
        period: "monthly",
      });
      await setBudget(tx, ownerRef(), {
        categoryId: comida,
        amountUsd: new Decimal(25),
        period: "biweekly",
      });
      await expect(
        setBudget(tx, ownerRef(), {
          categoryId: insumos,
          amountUsd: new Decimal(-5),
          period: "monthly",
        }),
      ).rejects.toBeInstanceOf(BudgetError);
      await expect(
        setBudget(tx, ownerRef(), {
          categoryId: "99999999-9999-4999-8999-999999999999",
          amountUsd: new Decimal(5),
          period: "monthly",
        }),
      ).rejects.toBeInstanceOf(BudgetError);
      const rows = await tx.select().from(schema.budget);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.categoryId === insumos)).toMatchObject({
        period: "monthly",
        amountUsd: "200.00",
      });
      const log = await tx
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.entity, "budget"));
      expect(log.map((l) => l.action)).toEqual(["create", "update", "create"]);
    });
  });

  it("al guardar, el dueño ve cuánto le queda; el empleado no", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "gasté 150$ en champú");
    await tap(client, saveId(sent[0]));
    expect(textOf(sent[1])).toBe(
      "✅ Guardado. Gastos de hoy: *$150,00* (1 registro).\nInsumos de lavado: te quedan *$50,00* de $200,00 este mes.",
    );
    await send(client, "gasté 20$ en cera");
    await tap(client, saveId(sent[2]));
    expect(textOf(sent[3])).toContain(
      "⚠️ Insumos de lavado: vas por el 85 %. Te quedan *$30,00* de $200,00 este mes.",
    );
    // El empleado guarda sin ver presupuestos: es información del dueño.
    await send(client, "gasté 10$ en arepas", EMPLOYEE);
    await tap(client, saveId(sent[4]), EMPLOYEE);
    expect(textOf(sent[5])).toBe("✅ Guardado. Gastos de hoy: *$180,00* (3 registros).");
    await send(client, "gasté 10$ en arepas");
    await tap(client, saveId(sent[6]));
    expect(textOf(sent[7])).toContain(
      "⚠️ Comida del personal: vas por el 80 %. Te quedan *$5,00* de $25,00 esta quincena.",
    );
  });

  it("la cuenta solo suma gastos vivos de la categoría en su ventana", async () => {
    await withTenant(t.db, tenantId, async (tx) => {
      // Un gasto de septiembre no cuenta en octubre; uno borrado tampoco.
      const [cat] = await tx.select().from(schema.movement).limit(1);
      if (!cat) throw new Error("sin movimientos");
      await tx.insert(schema.movement).values([
        { ...cat, id: undefined, businessDate: "2026-09-29", amountUsd: "500.00" },
        { ...cat, id: undefined, amountUsd: "500.00", deletedAt: now() },
      ]);
      const [ins] = await budgetStatuses(tx, tenantId, asIsoDate("2026-10-03"), [insumos]);
      expect(ins).toMatchObject({ pct: 85, from: "2026-10-01", to: "2026-10-31", daysLeft: 29 });
      expect(ins?.spentUsd.toFixed(2)).toBe("170.00");
      const [sep] = await budgetStatuses(tx, tenantId, asIsoDate("2026-09-29"), [insumos]);
      expect(sep?.spentUsd.toFixed(2)).toBe("500.00");
    });
  });

  it("consultas: una categoría, todas, sin presupuesto, inexistente y el empleado", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "cuánto me queda en insumos");
    expect(textOf(sent[0])).toBe(
      "⚠️ Insumos de lavado: vas por el 85 %. Te quedan *$30,00* de $200,00 este mes.\n_Faltan 29 días para que se reinicie el mes._",
    );
    await send(client, "cómo voy con los presupuestos");
    expect(textOf(sent[1])).toBe(
      "*Presupuestos* · sáb 03/10\n⚠️ Insumos de lavado: quedan *$30,00* de $200,00 (85 %)\n⚠️ Comida del personal: quedan *$5,00* de $25,00 (80 % · quincenal)\n_Mes: faltan 29 días. Quincena: faltan 13 días._",
    );
    await send(client, "cuánto me queda en publicidad");
    expect(textOf(sent[2])).toBe(
      "Publicidad no tiene presupuesto. Ponlo en https://caja.test/ajustes/categorias.",
    );
    await send(client, "cuánto me queda en viajes");
    expect(textOf(sent[3])).toContain('No tengo una categoría "viajes"');
    await send(client, "cuánto me queda en insumos", EMPLOYEE);
    expect(textOf(sent[4])).toBe(
      "Los presupuestos los ve el dueño. Tú puedes registrar gastos y ventas.",
    );
  });
});
