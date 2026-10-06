import { schema, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient } from "../src/agent/llm";
import { createAgent } from "../src/agent/loop";
import type { AgentContext } from "../src/agent/types";
import { asIsoDate } from "../src/domain/dates";
import { Decimal } from "../src/domain/money";

/** Calculadora de sumas (06/10): el modelo copia los montos y el backend hace la cuenta. */
function oneCall(input: Record<string, unknown>): LlmClient {
  return {
    model: "fake",
    async complete() {
      return {
        toolCalls: [{ id: "c1", name: "sum_amounts", input }],
        text: null,
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: "fake",
      };
    },
    costUsd: () => new Decimal(0),
  };
}

describe("sum_amounts", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  let ctx: AgentContext;
  const TEXT = "Suma todos estos montos 12030,30 26171,78 26171,78 56706 13085";

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Javier",
      businessType: "personal",
      ownerPhone: "584121234567",
    });
    const [phone] = await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.phoneNumber));
    await t.db
      .insert(schema.bcvRate)
      .values({ effectiveDate: "2026-10-06", rate: "872.39000000", source: "test" });
    ctx = {
      tenantId,
      tenantName: "Javier",
      phoneId: phone?.id as string,
      role: "owner",
      defaultCurrency: "USD",
      vesThreshold: "1000",
      categories: [],
      today: asIsoDate("2026-10-06"),
      sourceMessageDbId: null,
      attachmentId: null,
      sourceChannel: "text",
      dashboardUrl: "https://caja.test",
    };
  });
  afterAll(() => t.close());

  async function sum(input: Record<string, unknown>, text = TEXT) {
    return withTenant(t.db, tenantId, async (tx) => {
      const r = await createAgent({
        llm: oneCall({ currency: "unknown", to: "auto", rate: "", divide_by: 0, ...input }),
      }).run(tx, ctx, { kind: "text", text });
      const drafts = await tx.select().from(schema.pendingAction);
      return { body: (r.outbound[0] as { body: string }).body, drafts: drafts.length };
    });
  }
  const items = (...a: string[]) => a.map((amount) => ({ amount, subtract: false }));

  it("los montos de la captura: total exacto en Bs, en $ a la BCV y sin borrador", async () => {
    const r = await sum({ items: items("12030,30", "26171,78", "26171,78", "56706", "13085") });
    expect(r.body).toContain("🧮 *Suma* · tasa BCV 872,39");
    expect(r.body).toContain("+ Bs 56.706,00 = $65,00");
    // El total en $ es la suma de las líneas redondeadas.
    expect(r.body).toContain("*Total: Bs 134.164,86 = $153,79* _(asumí bolívares)_");
    expect(r.drafts).toBe(0);
  });

  it("con un cambio registrado, también en USDT a esa tasa", async () => {
    await withTenant(t.db, tenantId, (tx) =>
      tx.insert(schema.exchangeLot).values({
        tenantId,
        businessDate: "2026-10-06",
        usdAmount: "100.00",
        vesAmount: "97000.00",
        rate: "970.00000000",
        vesRemaining: "97000.00",
        source: "exchange",
      }),
    );
    const r = await sum({ items: items("12030,30", "26171,78"), currency: "VES" });
    expect(r.body).toContain("*Total: Bs 38.202,08 =");
    expect(r.body).toContain("🪙 39,38 USDT a tu último cambio (970,00)");
  });

  it("restas, dólares a Bs y dividir entre varios", async () => {
    const r = await sum(
      {
        items: [
          { amount: "500", subtract: false },
          { amount: "230", subtract: false },
          { amount: "80", subtract: true },
        ],
        currency: "USD",
        divide_by: 4,
      },
      "cuánto es 500$ + 230$ - 80$ entre 4",
    );
    expect(r.body).toContain("− $80,00 = Bs 69.791,20");
    expect(r.body).toContain("*Total: $650,00 = Bs 567.053,50*");
    expect(r.body).toContain("👥 Entre 4: *$162,50* c/u");
  });

  it("la prueba del 06/10: cada monto en $ pasado a Bs y la suma final en Bs", async () => {
    const r = await sum(
      { items: items("13,70", "15", "60", "65"), currency: "USD", to: "VES" },
      "Necesito que me calcules a tasa $ bcv estos montos y luego me sumes todo para darme un monto final en Bs 13,70$ 15$ 60$ 65$",
    );
    expect(r.body).toBe(
      [
        "🧮 *Suma* · tasa BCV 872,39",
        "  $13,70 = Bs 11.951,74",
        "+ $15,00 = Bs 13.085,85",
        "+ $60,00 = Bs 52.343,40",
        "+ $65,00 = Bs 56.705,35",
        "*Total: $153,70 = Bs 134.086,34*",
      ].join("\n"),
    );
  });

  it("un monto que no escribió el usuario: pregunta en vez de inventar", async () => {
    const r = await sum({ items: items("12030,30", "99999") });
    expect(r.body).toContain("No entendí bien los montos");
  });
});
