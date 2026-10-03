import { describe, expect, it } from "vitest";
import {
  convert,
  Decimal,
  formatMoney,
  money,
  parseVenezuelanAmount,
  rate,
  sum,
  toDbAmount,
} from "../src/domain/money";

const r = rate("858", "2026-09-29", "rate-1");

describe("convert", () => {
  it("USD a VES multiplica y redondea half-up", () => {
    const c = convert(money("15", "USD"), r);
    expect(c.amountUsd.toFixed(2)).toBe("15.00");
    expect(c.amountVes.toFixed(2)).toBe("12870.00");
  });
  it("VES a USD divide y redondea half-up", () => {
    const c = convert(money("2000", "VES"), r);
    expect(c.amountUsd.toFixed(2)).toBe("2.33");
    expect(c.amountVes.toFixed(2)).toBe("2000.00");
  });
  it("caso de borde 0,005 redondea hacia arriba (comercial), no bancario", () => {
    const c = convert(money("0.01", "USD"), rate("0.5", "2026-01-01", "x"));
    // 0.01 * 0.5 = 0.005 → 0.01 con half-up; el bancario daría 0.00
    expect(c.amountVes.toFixed(2)).toBe("0.01");
  });
  it("montos grandes en Bs no pierden precisión", () => {
    const c = convert(money("123456789012.34", "VES"), rate("858.12345678", "2026-01-01", "x"));
    expect(c.amountUsd.toFixed(2)).toBe("143868330.41");
  });
  it("tasa con 8 decimales se conserva", () => {
    expect(rate("36.12345678", "2026-01-01", "x").value.toFixed(8)).toBe("36.12345678");
    expect(() => rate("0", "2026-01-01", "x")).toThrow();
  });
});

describe("parseVenezuelanAmount", () => {
  it.each([
    ["15,50", "15.5"],
    ["1.200", "1200"],
    ["450.000,75", "450000.75"],
    ["1200.50", "1200.5"],
    ["15", "15"],
    ["1.234.567", "1234567"],
    ["0,5", "0.5"],
  ])("%s → %s", (input, expected) => {
    expect(parseVenezuelanAmount(input)?.toString()).toBe(expected);
  });
  // "1,200.50", "." y "," lanzaban DecimalError (500 en los formularios); ahora son null.
  it.each([["1,2,3"], ["abc"], ["1.23.4"], [""], ["1,200.50"], ["."], [","]])(
    "rechaza %s",
    (input) => {
      expect(parseVenezuelanAmount(input)).toBeNull();
    },
  );
});

describe("formatMoney", () => {
  it("formatea con coma decimal y punto de miles", () => {
    expect(formatMoney("15", "USD")).toBe("$15,00");
    expect(formatMoney("12870", "VES")).toBe("Bs 12.870,00");
    expect(formatMoney("-40", "USD")).toBe("−$40,00");
  });
  it("abrevia Bs por encima de 999.999.999", () => {
    expect(formatMoney("1850000000", "VES")).toBe("Bs 1.850,00 MM");
  });
});

describe("sum y toDbAmount", () => {
  it("suma sin errores de coma flotante", () => {
    expect(toDbAmount(sum(["0.1", "0.2"]))).toBe("0.30");
    expect(toDbAmount(new Decimal("2.345"))).toBe("2.35");
  });
});
