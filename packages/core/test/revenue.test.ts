import { describe, expect, it } from "vitest";
import { monthlyRevenueUsd, paidAmountUsd } from "../src/billing/revenue";
import { Decimal } from "../src/domain/money";

/** «Ingreso mensual recurrente» de /admin: lo que el negocio paga de verdad (07/11). */
const NOW = new Date("2026-11-07T15:00:00Z");

describe("monthlyRevenueUsd", () => {
  it("con el pago de fundador aprobado: lo que pagó, no el precio de lista", () => {
    const t = { plan: "personal", founderUntil: "2027-05-05" };
    expect(
      monthlyRevenueUsd(t, { plan: "personal", months: 1, amountUsd: "3.59" }, NOW).toString(),
    ).toBe("3.59");
  });
  it("un pago de varios meses se reparte por mes", () => {
    const t = { plan: "negocio", founderUntil: null };
    expect(
      monthlyRevenueUsd(t, { plan: "negocio", months: 3, amountUsd: "59.97" }, NOW).toString(),
    ).toBe("19.99");
  });
  it("sin pago (o de otro plan): el precio con el descuento de fundador vigente", () => {
    const founder = { plan: "personal", founderUntil: "2027-05-05" };
    expect(monthlyRevenueUsd(founder, null, NOW).toString()).toBe("3.59");
    expect(
      monthlyRevenueUsd(
        founder,
        { plan: "negocio", months: 1, amountUsd: "11.99" },
        NOW,
      ).toString(),
    ).toBe("3.59");
    // Fundador vencido: precio completo.
    expect(
      monthlyRevenueUsd({ plan: "personal", founderUntil: "2026-11-01" }, null, NOW).toString(),
    ).toBe("5.99");
  });
});

describe("paidAmountUsd (pago registrado a mano)", () => {
  const fallback = new Decimal("3.59");
  it("en dólares o USDT, el monto cobrado", () => {
    expect(paidAmountUsd(new Decimal("3.59"), "USD", null, fallback).toString()).toBe("3.59");
    expect(paidAmountUsd(new Decimal("3.6"), "USDT", null, fallback).toString()).toBe("3.6");
  });
  it("en bolívares, entre la tasa; sin tasa, el precio con el descuento", () => {
    expect(
      paidAmountUsd(new Decimal("3222.17"), "VES", new Decimal("897.54"), fallback).toString(),
    ).toBe("3.59");
    expect(paidAmountUsd(new Decimal("3222.17"), "VES", null, fallback).toString()).toBe("3.59");
  });
});
