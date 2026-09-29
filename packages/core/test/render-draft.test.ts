import { describe, expect, it } from "vitest";
import { asIsoDate } from "../src/domain/dates";
import { es } from "../src/render/index";
import { LIMITS } from "../src/whatsapp/client";

const base = {
  pendingId: "11111111-1111-4111-8111-111111111111",
  amount: "15.00",
  currency: "USD" as const,
  currencyInferred: false,
  amountUsd: "15.00",
  amountVes: "12870.00",
  rateValue: "858.00000000",
  rateEffectiveDate: "2026-09-29",
  businessDate: "2026-09-29",
  today: asIsoDate("2026-09-29"),
  categoryName: "Insumos de lavado",
  description: "Champú",
  transcript: null,
  replacedPrevious: false,
};

describe("borrador de gasto", () => {
  it("caso simple según el guion de la Fase 4", () => {
    const m = es.expenseDraft(base);
    expect(m.type).toBe("buttons");
    expect(m.body).toBe(
      "Gasto por confirmar:\n*$15,00* (Bs 12.870,00 a tasa 858,00)\nChampú · Insumos de lavado\nHoy, mar 29/09",
    );
    if (m.type === "buttons") {
      expect(m.buttons.map((b) => b.id)).toEqual([
        `confirm:${base.pendingId}`,
        `fix:${base.pendingId}`,
        `cancel:${base.pendingId}`,
      ]);
      for (const b of m.buttons) expect(b.title.length).toBeLessThanOrEqual(LIMITS.buttonTitle);
    }
  });
  it("bolívares inferidos, ayer, tasa de otro día, transcripción y borrador reemplazado", () => {
    const m = es.expenseDraft({
      ...base,
      amount: "450000.00",
      currency: "VES",
      currencyInferred: true,
      amountUsd: "524.48",
      amountVes: "450000.00",
      businessDate: "2026-09-28",
      rateEffectiveDate: "2026-09-25",
      categoryName: "Transporte y gasolina",
      description: "Gasolina",
      transcript: "anota cuatrocientos cincuenta mil de gasolina de ayer",
      replacedPrevious: true,
    });
    expect(m.body).toContain("Descarté el borrador anterior sin guardar.");
    expect(m.body).toContain('Entendí: _"anota cuatrocientos cincuenta mil de gasolina de ayer"_');
    expect(m.body).toContain(
      "*Bs 450.000,00* ($524,48 a tasa 858,00 del vie 25/09) · entendí bolívares",
    );
    expect(m.body).toContain("Ayer, lun 28/09");
    expect(m.body.length).toBeLessThanOrEqual(LIMITS.interactiveBody);
  });
  it("guardado con total del día", () => {
    expect(es.expenseSaved("47", 3).body).toBe(
      "✅ Guardado. Gastos de hoy: *$47,00* (3 registros).",
    );
  });
});
