import { describe, expect, it } from "vitest";
import { asIsoDate } from "../src/domain/dates";
import { Decimal } from "../src/domain/money";
import { es, parseReplyId } from "../src/render/index";
import { LIMITS } from "../src/whatsapp/client";

const rate = {
  current: { value: new Decimal("858"), effectiveDate: asIsoDate("2026-09-29") },
  next: { value: new Decimal("859.3"), effectiveDate: asIsoDate("2026-09-30") },
  stale: false,
};

describe("plantillas es-VE", () => {
  it("menú lleva la tasa del día y exactamente 3 botones dentro del límite", () => {
    const m = es.menu(rate);
    expect(m.type).toBe("buttons");
    if (m.type !== "buttons") return;
    expect(m.body).toContain("Tasa BCV hoy: *Bs 858,00* (vigente mar 29/09)");
    expect(m.buttons.map((b) => b.title)).toEqual([
      "Registrar gasto",
      "Registrar venta",
      "Ver cierre",
    ]);
    for (const b of m.buttons) expect(b.title.length).toBeLessThanOrEqual(LIMITS.buttonTitle);
    expect(m.body.length).toBeLessThanOrEqual(LIMITS.interactiveBody);
  });
  it("tasa muestra vigente y próxima; advierte si está vieja; avisa si no hay", () => {
    const r = es.rate(rate);
    expect(r.body).toContain("Vigente hoy (mar 29/09): *Bs 858,00*");
    expect(r.body).toContain("Próxima (mié 30/09): *Bs 859,30*");
    expect(es.rate({ ...rate, next: null, stale: true }).body).toContain("⚠️");
    expect(es.rate({ current: null, next: null, stale: false }).body).toContain("No tengo la tasa");
    expect(es.menu({ current: null, next: null, stale: false }).body).toContain("no disponible");
  });
  it("bienvenida menciona que es automático y el nombre del negocio", () => {
    const w = es.welcomeOwner("Autolavado El Rápido", "Asistente de Caja", rate);
    expect(w.body).toContain("*Autolavado El Rápido*");
    expect(w.body).toContain("asistente automático");
    expect(es.welcomeEmployee("Carlos", "Autolavado").body).toContain("¡Epa, Carlos! Soy Rocco");
  });
  it("ayuda incluye el enlace del dashboard y el soporte si existe", () => {
    expect(es.help("https://caja.app", null).body).toContain("https://caja.app");
    expect(es.help("https://caja.app", "wa.me/58412").body).toContain("wa.me/58412");
  });
  it("Rocco se presenta en la ayuda y celebra solo un día con ganancia", () => {
    expect(es.help("https://x", null).body).toContain("Soy Rocco 🐾");
    const day = (sales: string, expenses: string) =>
      es.dailyClose({
        date: "2026-10-07",
        today: "2026-10-07",
        salesUsd: sales,
        salesByMethod: [],
        expensesUsd: expenses,
        expensesByCategory: [],
        netUsd: new Decimal(sales).minus(expenses),
        netVes: null,
        rateValue: null,
        cashUsd: 0,
        cashVes: 0,
        count: 2,
        dashboardUrl: "https://x",
      }).body;
    expect(day("100", "40")).toContain("Buen día. ¡Sigue así!");
    expect(day("20", "40")).not.toContain("Sigue así");
    expect(day("0", "40")).not.toContain("Sigue así");
  });
  it("parseReplyId enruta por prefijo", () => {
    expect(parseReplyId("menu:expense")).toEqual({ kind: "menu", action: "expense" });
    expect(parseReplyId("confirm:abc-1")).toEqual({ kind: "confirm", pendingId: "abc-1" });
    expect(parseReplyId("currency:VES")).toEqual({ kind: "currency", currency: "VES" });
    expect(parseReplyId("cat:x:y")).toEqual({ kind: "unknown", raw: "cat:x:y" });
    expect(parseReplyId("cat:00000000-0000-4000-8000-000000000000")).toEqual({
      kind: "category",
      categoryId: "00000000-0000-4000-8000-000000000000",
    });
    expect(parseReplyId("whatever")).toEqual({ kind: "unknown", raw: "whatever" });
    expect(parseReplyId("menu:nope").kind).toBe("unknown");
  });
});
