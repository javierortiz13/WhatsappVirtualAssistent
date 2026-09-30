import { eq, schema, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LlmClient, LlmRequest, LlmResponse } from "../src/agent/llm";
import { LlmUnavailableError } from "../src/agent/llm";
import { createAgent } from "../src/agent/loop";
import type { AgentContext } from "../src/agent/types";
import { asIsoDate } from "../src/domain/dates";
import { Decimal } from "../src/domain/money";

/**
 * LLM falso: devuelve respuestas en orden y guarda cada request para inspeccionar turnos.
 * Cubre el loop sin red: guardrails, reintento por argumentos inválidos, historial y costo.
 */
function fakeLlm(responses: (Partial<LlmResponse> | Error)[]) {
  const requests: LlmRequest[] = [];
  let i = 0;
  const client: LlmClient = {
    model: "claude-sonnet-5-5",
    async complete(req) {
      requests.push(req);
      const r = responses[i++];
      if (!r) throw new Error("el LLM falso no tiene más respuestas");
      if (r instanceof Error) throw r;
      return {
        toolCalls: [],
        text: null,
        stopReason: "end_turn",
        usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: "claude-sonnet-5-5",
        ...r,
      };
    },
    costUsd: (u) =>
      new Decimal(u.inputTokens).mul(2).plus(new Decimal(u.outputTokens).mul(10)).div(1_000_000),
  };
  return { client, requests };
}

const textOf = (req: LlmRequest | undefined, i: number): string => {
  const turn = req?.turns[i];
  if (!turn || !("text" in turn) || !turn.text) throw new Error(`turno ${i} sin texto`);
  return turn.text;
};

const contentOf = (req: LlmRequest | undefined, i: number): string => {
  const turn = req?.turns[i];
  if (turn?.role !== "tool_result") throw new Error(`turno ${i} no es tool_result`);
  return turn.content;
};

const call = (name: string, input: unknown, id = "toolu_1") => ({
  toolCalls: [{ id, name, input }],
  stopReason: "tool_use" as const,
});

const expense = (over: Record<string, unknown> = {}) => ({
  amount: "15",
  currency: "USD",
  description: "Champú",
  category_name: "Insumos de lavado",
  when: "",
  rate: "",
  ...over,
});

describe("agent loop", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  let phoneId: string;
  let ctx: AgentContext;
  const now = () => new Date("2026-09-29T15:00:00Z");

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Autolavado El Rápido",
      businessType: "car_wash",
      ownerPhone: "584121234567",
    });
    const rows = await withTenant(t.db, tenantId, async (tx) => ({
      phone: await tx.select().from(schema.phoneNumber),
      cats: await tx
        .select({ id: schema.category.id, name: schema.category.name })
        .from(schema.category)
        .orderBy(schema.category.sortOrder),
    }));
    phoneId = rows.phone[0]?.id as string;
    await t.db.insert(schema.bcvRate).values([
      { effectiveDate: "2026-09-28", rate: "857.50000000", source: "test" },
      { effectiveDate: "2026-09-29", rate: "858.00000000", source: "test" },
    ]);
    ctx = {
      tenantId,
      tenantName: "Autolavado El Rápido",
      phoneId,
      role: "owner",
      defaultCurrency: "USD",
      vesThreshold: "1000",
      categories: rows.cats,
      today: asIsoDate("2026-09-29"),
      sourceMessageDbId: null,
      sourceChannel: "text",
      dashboardUrl: "https://caja.test",
    };
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await withTenant(t.db, tenantId, async (tx) => {
      await tx.delete(schema.pendingAction);
      await tx.delete(schema.message);
    });
  });

  const run = (llm: LlmClient, text: string, c: AgentContext = ctx) =>
    withTenant(t.db, tenantId, (tx) =>
      createAgent({ llm, now }).run(tx, c, { kind: "text", text }),
    );

  it("draft_expense crea el borrador y responde con los tres botones", async () => {
    const { client, requests } = fakeLlm([call("draft_expense", expense())]);
    const res = await run(client, "gasté 15$ en champú");
    expect(res.status).toBe("ok");
    expect(res.toolCalls).toEqual([{ name: "draft_expense", args: expense() }]);
    const out = res.outbound[0];
    expect(out?.type).toBe("buttons");
    if (out?.type !== "buttons") throw new Error("esperaba botones");
    expect(out.body).toContain("*$15,00*");
    expect(out.body).toContain("Bs 12.870,00");
    expect(out.body).toContain("Champú · Insumos de lavado");
    expect(out.buttons.map((b) => b.title)).toEqual(["Guardar", "Corregir", "Cancelar"]);
    const pending = await withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.pendingAction).where(eq(schema.pendingAction.phoneId, phoneId)),
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe("create_expense");
    expect(out.buttons[0]?.id).toBe(`confirm:${pending[0]?.id}`);
    // Costo: 1000 tokens de entrada a 2 USD/M + 50 de salida a 10 USD/M.
    expect(res.tokensIn).toBe(1000);
    expect(res.tokensOut).toBe(50);
    expect(res.costUsd).toBe("0.002500");
    // Request: dos bloques de sistema cacheados, cuatro herramientas estrictas, fecha en el turno.
    const req = requests[0];
    expect(req?.system.map((s) => s.cache)).toEqual([true, true]);
    expect(req?.system[1]?.text).toContain("Negocio: Autolavado El Rápido");
    expect(req?.tools).toHaveLength(9);
    expect(req?.turns).toHaveLength(1);
    expect(req?.turns[0]).toMatchObject({ role: "user" });
    expect(textOf(req, 0)).toContain("Fecha de hoy en Caracas: 2026-09-29");
    expect(textOf(req, 0)).toContain('"gasté 15$ en champú"');
  });

  it("sin tool_call → fuera de alcance; refusal → fuera de alcance", async () => {
    const a = await run(fakeLlm([{ text: "¡Hola! ¿Cómo estás?" }]).client, "hola qué tal");
    expect(a.status).toBe("rejected_out_of_scope");
    expect(a.outbound[0]?.type).toBe("buttons");
    const b = await run(fakeLlm([{ stopReason: "refusal" }]).client, "x");
    expect(b.status).toBe("rejected_out_of_scope");
  });

  it("argumentos inválidos: un reintento con tool_result de error; dos seguidos → fuera de alcance", async () => {
    const { client, requests } = fakeLlm([
      call("draft_expense", { amount: "15" }),
      call("draft_expense", expense(), "toolu_2"),
    ]);
    const res = await run(client, "gasté 15$ en champú");
    expect(res.status).toBe("ok");
    expect(res.toolCalls).toHaveLength(1);
    const second = requests[1];
    expect(second?.turns).toHaveLength(3);
    expect(second?.turns[2]).toMatchObject({ role: "tool_result", isError: true });
    expect(contentOf(second, 2)).toContain("Argumentos inválidos");

    const twice = fakeLlm([call("unknown_tool", {}), call("draft_expense", { amount: 1 })]);
    const bad = await run(twice.client, "x");
    expect(bad.status).toBe("rejected_out_of_scope");
    expect(twice.requests).toHaveLength(2);
  });

  it("ask_clarification: cifras inventadas se reemplazan por la pregunta genérica", async () => {
    const invented = await run(
      fakeLlm([call("ask_clarification", { question: "¿Fueron 20 dólares?", options: [] })]).client,
      "gasté en champú",
    );
    expect(invented.outbound[0]).toEqual({
      type: "text",
      body: "No entendí bien. ¿Me lo repites con el monto y en qué lo gastaste?",
    });
    const grounded = await run(
      fakeLlm([
        call("ask_clarification", {
          question: "¿Los 15 fueron gasto o venta?",
          options: ["Gasto", "Venta"],
        }),
      ]).client,
      "15 de champú",
    );
    expect((grounded.outbound[0] as { body: string }).body).toBe(
      "¿Los 15 fueron gasto o venta?\n• Gasto\n• Venta",
    );
  });

  it("reject_out_of_scope y get_bcv_rate", async () => {
    const rej = await run(
      fakeLlm([call("reject_out_of_scope", { reason: "general_chat" })]).client,
      "cuéntame un chiste",
    );
    expect(rej.status).toBe("rejected_out_of_scope");
    expect(rej.outbound[0]?.type).toBe("buttons");
    const soon = await run(
      fakeLlm([call("reject_out_of_scope", { reason: "other_business_task" })]).client,
      "vendí 200$",
    );
    expect((soon.outbound[0] as { body: string }).body).toContain("todavía no lo hago por chat");
    const rate = await run(fakeLlm([call("get_bcv_rate", {})]).client, "a cuánto está el dólar");
    expect(rate.status).toBe("ok");
    expect((rate.outbound[0] as { body: string }).body).toContain("Bs 858,00");
  });

  it("draft_expense con monto ilegible, fecha futura o moneda ambigua pide aclaración sin escribir", async () => {
    const bad = await run(
      fakeLlm([call("draft_expense", expense({ amount: "quince" }))]).client,
      "gasté quince",
    );
    expect((bad.outbound[0] as { body: string }).body).toContain("No entendí el monto");
    const future = await run(
      fakeLlm([call("draft_expense", expense({ when: "2026-10-05" }))]).client,
      "x",
    );
    expect((future.outbound[0] as { body: string }).body).toContain("fecha es futura");
    const ask = await run(
      fakeLlm([call("draft_expense", expense({ currency: "unknown", amount: "500" }))]).client,
      "pagué 500 de luz",
      { ...ctx, defaultCurrency: null },
    );
    expect((ask.outbound[0] as { body: string }).body).toContain("¿500 en qué moneda?");
    const pending = await withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.pendingAction),
    );
    expect(pending).toHaveLength(0);
  });

  it("moneda por umbral: 450000 sin moneda es VES; 'ayer' resuelve la fecha", async () => {
    const res = await run(
      fakeLlm([
        call(
          "draft_expense",
          expense({ amount: "450000", currency: "unknown", description: "Hielo", when: "ayer" }),
        ),
      ]).client,
      "ayer 450 mil de hielo",
    );
    const body = (res.outbound[0] as { body: string }).body;
    expect(body).toContain("*Bs 450.000,00*");
    expect(body).toContain("($524,78 a tasa 857,50)");
    expect(body).toContain("entendí bolívares");
    expect(body).toContain("Ayer, lun 28/09");
  });

  it("historial reciente entra como turnos alternos y excluye el mensaje actual", async () => {
    await withTenant(t.db, tenantId, (tx) =>
      tx.insert(schema.message).values([
        {
          tenantId,
          phoneId,
          direction: "in",
          kind: "text",
          body: "hola",
          waMessageId: "wamid.h1",
          createdAt: new Date("2026-09-29T14:50:00Z"),
        },
        {
          tenantId,
          phoneId,
          direction: "out",
          kind: "text",
          body: "Menú enviado",
          createdAt: new Date("2026-09-29T14:50:01Z"),
        },
        {
          tenantId,
          phoneId,
          direction: "in",
          kind: "text",
          body: "gasté 15$ en champú",
          waMessageId: "wamid.h2",
          createdAt: new Date("2026-09-29T14:59:00Z"),
        },
      ]),
    );
    const { client, requests } = fakeLlm([call("draft_expense", expense())]);
    await run(client, "gasté 15$ en champú");
    const turns = requests[0]?.turns ?? [];
    expect(turns.map((x) => x.role)).toEqual(["user", "assistant", "user"]);
    expect(textOf(requests[0], 0)).toContain('"hola"');
    expect(textOf(requests[0], 1)).toContain("Menú enviado");
    expect(textOf(requests[0], 2)).toContain("Mensaje del usuario:");
  });

  it("borrador en corrección: el turno lleva el borrador y el nuevo draft lo reemplaza", async () => {
    const first = fakeLlm([call("draft_expense", expense())]);
    await run(first.client, "gasté 15$ en champú");
    await withTenant(t.db, tenantId, (tx) =>
      tx
        .update(schema.pendingAction)
        .set({ payload: { amount: "15", currency: "USD", fixing: true } }),
    );
    const second = fakeLlm([call("draft_expense", expense({ amount: "18" }))]);
    const res = await run(second.client, "eran 18");
    expect(textOf(second.requests[0], 0)).toContain("borrador SIN GUARDAR en corrección");
    expect((res.outbound[0] as { body: string }).body).toContain("Descarté el borrador anterior");
    const pending = await withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.pendingAction).where(eq(schema.pendingAction.status, "pending")),
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]?.payload).toMatchObject({ amount: "18.00" });
  });

  it("si el proveedor falla, el error sube tal cual (lo traduce el procesador)", async () => {
    const { client } = fakeLlm([new LlmUnavailableError("Anthropic 529: overloaded")]);
    await expect(run(client, "x")).rejects.toBeInstanceOf(LlmUnavailableError);
  });

  it("tope de iteraciones: una herramienta 'continue' inexistente no aplica; el loop corta en 3", async () => {
    // Todas las herramientas actuales son terminales; con tres respuestas inválidas el loop
    // termina antes por el guardrail de reintentos. Verificamos que nunca pasa de maxIterations.
    const { client, requests } = fakeLlm([
      call("draft_expense", {}),
      call("draft_expense", {}),
      call("draft_expense", {}),
    ]);
    const res = await run(client, "x");
    expect(res.status).toBe("rejected_out_of_scope");
    expect(requests.length).toBeLessThanOrEqual(3);
  });
});
