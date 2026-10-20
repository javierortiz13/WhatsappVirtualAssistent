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
    expect(m.body).toContain("Tasa BCV hoy: dólar *Bs 858,00* (vigente mar 29/09)");
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
    expect(r.body).toContain("💵 *Tasa BCV* · vigente hoy (mar 29/09)\nDólar: *Bs 858,00*");
    expect(r.body).toContain("Próxima (mié 30/09):\nDólar: Bs 859,30");
    // Con el euro del BCV, las dos tasas juntas (11/10: preguntaron por el euro).
    const withEur = es.rate({
      ...rate,
      current: rate.current ? { ...rate.current, eur: new Decimal("980.61") } : null,
    });
    expect(withEur.body).toContain("Dólar: *Bs 858,00*\nEuro: *Bs 980,61*");
    expect(
      es.menu({
        ...rate,
        current: rate.current ? { ...rate.current, eur: new Decimal("980.61") } : null,
      }).body,
    ).toContain("Tasa BCV hoy: dólar *Bs 858,00* · euro *Bs 980,61* (vigente mar 29/09)");
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
        cashSalesUsd: 0,
        cashSalesVes: 0,
        cash: null,
        unassigned: null,
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

/** "Debería haber en caja" en el cierre del bot (PRD cash-in-drawer, US-009: C1, C2, C3 y C4a). */
describe("cierre con cuentas de efectivo", () => {
  const close = (over: Partial<es.DailyCloseView> = {}) =>
    es.dailyClose({
      date: "2026-10-19",
      today: "2026-10-19",
      salesUsd: "250",
      salesByMethod: [],
      expensesUsd: "45",
      expensesByCategory: [],
      netUsd: "205",
      netVes: null,
      rateValue: null,
      cashSalesUsd: "200",
      cashSalesVes: "50000",
      cash: {
        usd: { net: "55", balanceEnd: "105" },
        ves: { net: "18000", balanceEnd: "18000" },
      },
      unassigned: { sales: { count: 0, usd: 0 }, expenses: { count: 0, usd: 0 } },
      count: 7,
      dashboardUrl: "https://x",
      ...over,
    }).body;
  const ojo = (sales: [number, string], expenses: [number, string]) =>
    close({
      unassigned: {
        sales: { count: sales[0], usd: sales[1] },
        expenses: { count: expenses[0], usd: expenses[1] },
      },
    });

  it("el ejemplo del PRD: lo que debería haber y lo que movió hoy, por moneda", () => {
    const body = close();
    expect(body).toContain("*Debería haber en caja: $105,00 · Bs 18.000,00*");
    expect(body).toContain("Hoy: +$55,00 · +Bs 18.000,00");
    expect(body).not.toContain("Ventas en efectivo");
    expect(body).not.toContain("Ojo:");
    expect(body).not.toContain("Efectivo en caja");
  });

  it("un día pasado dice 'Ese día'; un día negativo lleva un solo menos; cero sin signo", () => {
    expect(close({ date: "2026-10-18" })).toContain("Ese día: +$55,00 · +Bs 18.000,00");
    const body = close({
      cash: { usd: { net: "-20", balanceEnd: "30" }, ves: { net: 0, balanceEnd: 0 } },
    });
    expect(body).toContain("Hoy: −$20,00 · Bs 0,00");
    expect(body).not.toContain("−−");
    expect(body).not.toContain("+−");
  });

  it("solo la moneda que tiene cuenta de efectivo: sin 'Bs 0,00' de una gaveta que no existe", () => {
    const body = close({ cash: { usd: { net: "55", balanceEnd: "105" }, ves: null } });
    expect(body).toContain("*Debería haber en caja: $105,00*");
    expect(body).toContain("Hoy: +$55,00\n");
    const bs = close({ cash: { usd: null, ves: { net: "18000", balanceEnd: "18000" } } });
    expect(bs).toContain("*Debería haber en caja: Bs 18.000,00*");
    expect(bs).toContain("Hoy: +Bs 18.000,00\n");
  });

  it("lo que no tiene cuenta se dice aparte, cada monto con su tipo y nunca sumado", () => {
    expect(ojo([0, "0"], [1, "20"])).toContain(
      "Ojo: 1 gasto ($20,00) sin cuenta no entra en lo que debería haber en caja. Ponle la cuenta en el panel, en Movimientos.",
    );
    expect(ojo([2, "80"], [0, "0"])).toContain(
      "Ojo: 2 ventas ($80,00) sin cuenta no entran en lo que debería haber en caja. Ponles la cuenta en el panel, en Movimientos.",
    );
    expect(ojo([1, "30"], [2, "45"])).toContain(
      "Ojo: 1 venta ($30,00) y 2 gastos ($45,00) sin cuenta no entran en lo que debería haber en caja. Ponles la cuenta en el panel, en Movimientos.",
    );
  });

  it("sin cuentas de efectivo: 'Ventas en efectivo' y nunca el aviso de sin cuenta", () => {
    const body = close({
      cash: null,
      unassigned: { sales: { count: 0, usd: 0 }, expenses: { count: 1, usd: "20" } },
    });
    expect(body).toContain("Ventas en efectivo: $200,00 · Bs 50.000,00");
    expect(body).not.toContain("Ojo:");
    expect(body).not.toContain("Debería haber");
  });
});

describe("gastos de una categoría por chat", () => {
  it("lista los más recientes, dice cuántos faltan y enlaza al panel", () => {
    const items = Array.from({ length: 15 }, (_, i) => ({
      date: asIsoDate(`2026-10-${String(19 - i).padStart(2, "0")}`),
      description: i === 1 ? null : `Gasto ${i + 1}`,
      amount: i === 2 ? "3500" : "10",
      currency: (i === 2 ? "VES" : "USD") as "USD" | "VES",
    }));
    const body = es.categoryTotal({
      name: "Novia",
      periodLabel: "octubre (1 al 19)",
      usd: "245",
      ves: "245000",
      count: 18,
      items,
      link: "https://x/movimientos?mes=2026-10&tipo=expense&categoria=abc",
    }).body;
    expect(body).toContain("Novia, octubre (1 al 19): *$245,00* (Bs 245.000,00) en 18 gastos.");
    expect(body).toContain("lun 19/10 · Gasto 1 · $10,00");
    expect(body).toContain("dom 18/10 · Sin descripción · $10,00");
    expect(body).toContain("sáb 17/10 · Gasto 3 · Bs 3.500,00");
    expect(body).toContain("…y 3 más.");
    expect(body).toContain(
      "Todos en el panel: https://x/movimientos?mes=2026-10&tipo=expense&categoria=abc",
    );
    expect(body.length).toBeLessThan(LIMITS.textBody);
  });
});

describe("el saldo que quedará en la tarjeta del gasto", () => {
  const card = (showBalance: boolean, uncoveredVes = "0") =>
    es.expenseDraft({
      pendingId: "p1",
      amount: "970",
      currency: "VES",
      currencyInferred: false,
      amountUsd: "1",
      amountVes: "970",
      rateValue: "970",
      rateEffectiveDate: "2026-10-19",
      rateSource: "exchange",
      businessDate: "2026-10-19",
      today: asIsoDate("2026-10-19"),
      categoryName: "Comida",
      description: "Pan",
      transcript: null,
      replacedPrevious: false,
      exchange: { remainingAfter: "87300", uncoveredVes, lastRate: "970" },
      accountName: "Banesco",
      showBalance,
    }).body;

  it("lo ve el dueño, no el empleado (jpsoftwaredev#18)", () => {
    expect(card(true)).toContain("Quedarán Bs 87.300,00 en Banesco.");
    expect(card(false)).not.toContain("Quedarán");
    expect(card(false)).not.toContain("87.300");
  });

  it("el aviso de que no alcanza sí lo ven los dos: es de este gasto, no un saldo", () => {
    expect(card(false, "100")).toContain("⚠️ No alcanza lo que hay en Banesco");
  });
});
