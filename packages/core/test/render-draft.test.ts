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
      "*Gasto por confirmar*\nChampú: *$15,00*\nBs 12.870,00 · tasa BCV 858,00\nCategoría: Insumos de lavado\nFecha: hoy, mar 29/09",
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
    expect(m.body).toContain("Gasolina: *Bs 450.000,00*\n$524,48 · tasa BCV 858,00 del vie 25/09");
    expect(m.body).toContain("Fecha: ayer, lun 28/09");
    expect(m.body).toContain("_No dijiste la moneda: lo tomé en bolívares._");
    expect(m.body.length).toBeLessThanOrEqual(LIMITS.interactiveBody);
  });
  it("guardado con total del día", () => {
    expect(es.expenseSaved("47", 3).body).toBe(
      "✅ Guardado. Gastos de hoy: *$47,00* (3 registros).",
    );
  });
});

describe("borrador de varios gastos", () => {
  const item = {
    amount: "7.00",
    currency: "USD" as const,
    currencyInferred: false,
    amountUsd: "7.00",
    amountVes: "6006.00",
    rateValue: "858.00000000",
    rateEffectiveDate: "2026-09-29",
    rateSource: "bcv" as const,
    businessDate: "2026-09-29",
    categoryName: "Comida del personal",
    description: "Arepa y malta",
  };
  it("un renglón por gasto, total y una sola confirmación", () => {
    const m = es.expensesDraft({
      pendingId: base.pendingId,
      items: [
        item,
        {
          ...item,
          amount: "7.50",
          amountUsd: "7.50",
          amountVes: "6435.00",
          description: "Partida de pádel",
          categoryName: "Otros",
        },
      ],
      today: asIsoDate("2026-09-29"),
      transcript: null,
      replacedPrevious: false,
    });
    expect(m.body).toBe(
      "*2 gastos por confirmar*\n1. Arepa y malta: *$7,00* · Comida del personal\n2. Partida de pádel: *$7,50* · Otros\nTotal: *$14,50* · Bs 12.441,00 · tasa BCV 858,00\nFecha: hoy, mar 29/09",
    );
    if (m.type === "buttons")
      expect(m.buttons.map((b) => b.title)).toEqual(["Guardar", "Corregir", "Cancelar"]);
  });
  it("días distintos van en cada renglón", () => {
    const m = es.expensesDraft({
      pendingId: base.pendingId,
      items: [item, { ...item, businessDate: "2026-09-28" }],
      today: asIsoDate("2026-09-29"),
      transcript: null,
      replacedPrevious: false,
    });
    expect(m.body).toContain("· ayer, lun 28/09");
    expect(m.body).not.toMatch(/\nHoy,/);
  });
});
