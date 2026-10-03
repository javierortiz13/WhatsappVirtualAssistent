import { schema, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient } from "../src/agent/llm";
import { createAgent } from "../src/agent/loop";
import type { AgentContext } from "../src/agent/types";
import { asIsoDate } from "../src/domain/dates";
import { Decimal } from "../src/domain/money";

/** Calculadora (03/10): Bs ↔ $ ↔ € con la BCV, el euro BCV o la tasa que diga. No registra nada. */
function oneCall(input: Record<string, unknown>): LlmClient {
  return {
    model: "fake",
    async complete() {
      return {
        toolCalls: [{ id: "c1", name: "convert_currency", input }],
        text: null,
        stopReason: "tool_use",
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: "fake",
      };
    },
    costUsd: () => new Decimal(0),
  };
}

describe("convert_currency", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  let ctx: AgentContext;

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Autolavado",
      businessType: "car_wash",
      ownerPhone: "584121234567",
    });
    const [phone] = await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.phoneNumber));
    await t.db.insert(schema.bcvRate).values({
      effectiveDate: "2026-10-02",
      rate: "858.00000000",
      rateEur: "960.00000000",
      source: "test",
    });
    ctx = {
      tenantId,
      tenantName: "Autolavado",
      phoneId: phone?.id as string,
      role: "employee",
      defaultCurrency: "USD",
      vesThreshold: "1000",
      categories: [],
      today: asIsoDate("2026-10-03"),
      sourceMessageDbId: null,
      attachmentId: null,
      sourceChannel: "text",
      dashboardUrl: "https://caja.test",
    };
  });
  afterAll(() => t.close());

  async function convert(input: Record<string, unknown>) {
    return withTenant(t.db, tenantId, async (tx) => {
      const r = await createAgent({ llm: oneCall({ rate: "", ...input }) }).run(tx, ctx, {
        kind: "text",
        text: "x",
      });
      const drafts = await tx.select().from(schema.pendingAction);
      return { body: (r.outbound[0] as { body: string }).body, drafts: drafts.length };
    });
  }

  it("8000 Bs en $: BCV y el equivalente en euros; no deja borrador", async () => {
    const r = await convert({ amount: "8000", from: "VES", to: "auto" });
    expect(r.body).toBe(
      "🧮 Bs 8.000,00 son *$9,32* (≈ 8,33 €)\nTasa BCV: Bs 858,00 (vigente vie 02/10).",
    );
    expect(r.drafts).toBe(0);
  });

  it("17 € en Bs con el euro BCV", async () => {
    const r = await convert({ amount: "17", from: "EUR", to: "auto" });
    expect(r.body).toBe(
      "🧮 17,00 € son *Bs 16.320,00*\nTasa euro BCV: Bs 960,00 (vigente vie 02/10).",
    );
  });

  it("15$ en bolívares, a una tasa dicha y a tasa euro", async () => {
    expect((await convert({ amount: "15", from: "USD", to: "VES" })).body).toContain(
      "*Bs 12.870,00*",
    );
    const manual = await convert({ amount: "20", from: "USD", to: "VES", rate: "1000" });
    expect(manual.body).toBe("🧮 $20,00 son *Bs 20.000,00*\nA tasa 1.000,00.");
    const euro = await convert({ amount: "10", from: "USD", to: "VES", rate: "euro" });
    expect(euro.body).toContain("*Bs 9.600,00*");
    expect(euro.body).toContain("Tasa euro BCV");
  });

  it("$ a € pasa por las dos tasas oficiales", async () => {
    const r = await convert({ amount: "100", from: "USD", to: "EUR" });
    expect(r.body).toContain("son *89,38 €*");
    expect(r.body).toContain("Tasa BCV: Bs 858,00");
    expect(r.body).toContain("Tasa euro BCV: Bs 960,00");
  });

  it("monto ilegible, misma moneda o tasa absurda: pregunta", async () => {
    expect((await convert({ amount: "x", from: "USD", to: "VES" })).body).toContain("¿Qué monto");
    expect((await convert({ amount: "5", from: "USD", to: "USD" })).body).toContain(
      "¿A qué moneda",
    );
    expect((await convert({ amount: "5", from: "USD", to: "VES", rate: "9" })).body).toContain(
      "No entendí la tasa",
    );
  });
});
