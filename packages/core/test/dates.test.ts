import { describe, expect, it } from "vitest";
import {
  addDays,
  asIsoDate,
  businessDateOf,
  formatShortDate,
  isWeekend,
  monthNameEs,
  resolveRelativeDate,
} from "../src/domain/dates.js";

describe("businessDateOf", () => {
  it("usa la hora de Caracas (UTC-4): 03:30Z del 30 es aún el 29 en Caracas", () => {
    expect(businessDateOf(new Date("2026-09-30T03:30:00Z"))).toBe("2026-09-29");
    expect(businessDateOf(new Date("2026-09-30T04:30:00Z"))).toBe("2026-09-30");
  });
});

describe("fechas relativas", () => {
  const today = asIsoDate("2026-09-29"); // martes
  it("hoy, ayer, antier", () => {
    expect(resolveRelativeDate("hoy", today)).toBe("2026-09-29");
    expect(resolveRelativeDate("ayer", today)).toBe("2026-09-28");
    expect(resolveRelativeDate("antier", today)).toBe("2026-09-27");
  });
  it("'el lunes' es el lunes más reciente, 'el martes' es hoy", () => {
    expect(resolveRelativeDate("el lunes", today)).toBe("2026-09-28");
    expect(resolveRelativeDate("martes", today)).toBe("2026-09-29");
    expect(resolveRelativeDate("el miércoles", today)).toBe("2026-09-23");
  });
  it("palabra desconocida devuelve null", () => {
    expect(resolveRelativeDate("navidad", today)).toBeNull();
  });
});

describe("utilidades", () => {
  it("addDays cruza meses", () => {
    expect(addDays(asIsoDate("2026-09-30"), 1)).toBe("2026-10-01");
  });
  it("fin de semana", () => {
    expect(isWeekend(asIsoDate("2026-09-27"))).toBe(true);
    expect(isWeekend(asIsoDate("2026-09-29"))).toBe(false);
  });
  it("formato corto y mes", () => {
    expect(formatShortDate(asIsoDate("2026-09-29"))).toBe("mar 29/09");
    expect(monthNameEs(asIsoDate("2026-09-29"))).toBe("Septiembre");
  });
  it("rechaza fechas inválidas", () => {
    expect(() => asIsoDate("2026-02-30")).toThrow();
  });
});
