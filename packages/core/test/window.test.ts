import { describe, expect, it } from "vitest";
import { WINDOW_SAFE_MS, windowOpenAt } from "../src/inbox/window";

/** US-202: un solo margen para la ventana de servicio de Meta (23 h 30 min). */
describe("windowOpenAt", () => {
  const now = new Date("2026-11-10T14:00:00Z");
  const ago = (h: number, m: number) => new Date(now.getTime() - (h * 60 + m) * 60_000);
  it("abierta a las 23:29, cerrada a las 23:30 y a las 23:31", () => {
    expect(windowOpenAt(ago(23, 29), now)).toBe(true);
    expect(windowOpenAt(ago(23, 30), now)).toBe(false);
    expect(windowOpenAt(ago(23, 31), now)).toBe(false);
  });
  it("sin mensajes entrantes, cerrada", () => {
    expect(windowOpenAt(null, now)).toBe(false);
  });
  it("el margen es de 23 h 30 min", () => {
    expect(WINDOW_SAFE_MS).toBe(23.5 * 3_600_000);
  });
});
