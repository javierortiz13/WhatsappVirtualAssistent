import { describe, expect, it } from "vitest";
import {
  caracasInstant,
  type DueAt,
  dueBaseOf,
  type IsoDate,
  resolveDueAt,
} from "../src/domain/dates";

/** US-302: hoy es martes 10/11/2026 a las 10:00 de Caracas (14:00 UTC). */
const NOW = new Date("2026-11-10T14:00:00Z");
const local = (r: DueAt) =>
  r.kind === "ok"
    ? `${r.dueDate} ${String(new Date(r.dueAt.getTime() - 4 * 3_600_000).getUTCHours()).padStart(2, "0")}:${String(r.dueAt.getUTCMinutes()).padStart(2, "0")}${r.timeWasDefault ? " (9 am por defecto)" : ""}`
    : r.kind;

describe("resolveDueAt (tabla del PRD)", () => {
  it.each([
    ["el viernes a las 9 am", "2026-11-13 09:00"],
    ["el viernes a las 9", "ambiguous_hour"],
    ["mañana", "2026-11-11 09:00 (9 am por defecto)"],
    ["hoy a las 3", "2026-11-10 15:00"],
    ["el martes a las 9 am", "hour_passed"],
    ["el 15", "2026-11-15 09:00 (9 am por defecto)"],
    ["fin de mes", "2026-11-30 09:00 (9 am por defecto)"],
    ["la quincena", "2026-11-15 09:00 (9 am por defecto)"],
    ["en 3 días", "2026-11-13 09:00 (9 am por defecto)"],
    ["el 3 de noviembre", "past"],
    ["el 10 de noviembre de 2028", "too_far"],
    ["a mediodía", "2026-11-10 12:00"],
    ["mañana en la noche", "2026-11-11 20:00"],
    ["el jueves en la tarde", "2026-11-12 15:00"],
    ["mañana en la mañana", "2026-11-11 09:00"],
    ["mañana a las 9 de la mañana", "2026-11-11 09:00"],
    ["el viernes a las 8 de la noche", "2026-11-13 20:00"],
    ["el lunes a las 9:30 pm", "2026-11-16 21:30"],
    ["el 20 a las 12", "2026-11-20 12:00"],
    ["pasado mañana a las 6", "2026-11-12 18:00"],
    ["el 5 de enero", "2027-01-05 09:00 (9 am por defecto)"],
    ["el 5", "2026-12-05 09:00 (9 am por defecto)"],
    ["15/11 a las 10 am", "2026-11-15 10:00"],
    ["pagar la luz", "no_date"],
  ])("%s → %s", (phrase, expected) => {
    expect(local(resolveDueAt(phrase, NOW))).toBe(expected);
  });
  it("el 30 en febrero es el último día de febrero", () => {
    expect(local(resolveDueAt("el 30", new Date("2027-02-10T14:00:00Z")))).toBe(
      "2027-02-28 09:00 (9 am por defecto)",
    );
  });
  it("la quincena después del 15 es fin de mes", () => {
    expect(local(resolveDueAt("la quincena", new Date("2026-11-20T14:00:00Z")))).toBe(
      "2026-11-30 09:00 (9 am por defecto)",
    );
  });
  it("las 9 sin am/pm devuelve la hora y la fecha para preguntar", () => {
    expect(resolveDueAt("el viernes a las 9", NOW)).toEqual({
      kind: "ambiguous_hour",
      hour: 9,
      minute: 0,
      date: "2026-11-13",
    });
  });
  it("al corregir, lo que la frase no dice se queda (H15b)", () => {
    // El recordatorio era el viernes 13 a las 3 pm.
    const base = dueBaseOf(caracasInstant("2026-11-13" as IsoDate, 15), false);
    expect(local(resolveDueAt("a las 4 pm", NOW, base))).toBe("2026-11-13 16:00");
    expect(local(resolveDueAt("el lunes", NOW, base))).toBe("2026-11-16 15:00");
    expect(local(resolveDueAt("el lunes a las 10 am", NOW, base))).toBe("2026-11-16 10:00");
    expect(resolveDueAt("a las 9", NOW, base)).toMatchObject({
      kind: "ambiguous_hour",
      date: "2026-11-13",
    });
    // Con las 9 am por defecto, cambiar el día deja el aviso "por defecto".
    const byDefault = dueBaseOf(caracasInstant("2026-11-13" as IsoDate, 9), true);
    expect(local(resolveDueAt("el lunes", NOW, byDefault))).toBe(
      "2026-11-16 09:00 (9 am por defecto)",
    );
  });
});
