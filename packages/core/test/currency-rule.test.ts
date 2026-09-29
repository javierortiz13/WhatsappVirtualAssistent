import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { inferCurrency } from "../src/domain/currency-rule.js";

const threshold = new Decimal(1000);

describe("inferCurrency", () => {
  it("la moneda explícita manda aunque supere el umbral", () => {
    expect(
      inferCurrency({
        explicit: "USD",
        amount: new Decimal(1500),
        threshold,
        tenantDefault: "USD",
      }),
    ).toEqual({
      kind: "explicit",
      currency: "USD",
    });
  });
  it("2.000 sin moneda es bolívares", () => {
    expect(
      inferCurrency({ explicit: null, amount: new Decimal(2000), threshold, tenantDefault: "USD" }),
    ).toEqual({
      kind: "inferred",
      currency: "VES",
      reason: "threshold",
    });
  });
  it("40 sin moneda usa la moneda por defecto del tenant", () => {
    expect(
      inferCurrency({ explicit: null, amount: new Decimal(40), threshold, tenantDefault: "USD" }),
    ).toEqual({
      kind: "inferred",
      currency: "USD",
      reason: "tenant_default",
    });
  });
  it("exactamente el umbral es bolívares", () => {
    expect(
      inferCurrency({ explicit: null, amount: new Decimal(1000), threshold, tenantDefault: "USD" })
        .kind,
    ).toBe("inferred");
  });
  it("sin moneda por defecto y bajo el umbral, pregunta", () => {
    expect(
      inferCurrency({ explicit: null, amount: new Decimal(40), threshold, tenantDefault: null }),
    ).toEqual({
      kind: "ask",
    });
  });
});
