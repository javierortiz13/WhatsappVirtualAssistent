import { describe, expect, it } from "vitest";
import { Decimal } from "../src/domain/money";
import { type Bill, computeSplit } from "../src/domain/split";

/** Dividir la cuenta (06/10): la cuenta la hace el backend con Decimal, no el modelo. */
const bill: Bill = {
  vendor: "Pizzería Napoli",
  currency: "USD",
  items: [
    { name: "Pizza margarita", quantity: 1, amount: new Decimal("12.00") },
    { name: "Hamburguesa", quantity: 1, amount: new Decimal("9.00") },
    { name: "Cerveza", quantity: 3, amount: new Decimal("6.00") },
    { name: "Postre", quantity: 1, amount: new Decimal("3.00") },
  ],
  // 30 de renglones + 10 % de servicio.
  total: new Decimal("33.00"),
};
const totals = (r: ReturnType<typeof computeSplit>) =>
  r?.mode === "items"
    ? Object.fromEntries(r.people.map((p) => [p.name, p.total.toFixed(2)]))
    : null;

describe("computeSplit", () => {
  it("cada uno lo suyo, con el servicio repartido según lo que consumió", () => {
    const r = computeSplit(bill, {
      people: [
        {
          name: "Tú",
          isMe: true,
          items: [
            { index: 1, units: 0 },
            { index: 4, units: 0 },
          ],
        },
        {
          name: "Pedro",
          isMe: false,
          items: [
            { index: 2, units: 0 },
            { index: 3, units: 0 },
          ],
        },
      ],
      sharedByAll: [],
      equalSplit: 0,
    });
    // Tú 15 + 1,50 de servicio; Pedro 15 + 1,50.
    expect(totals(r)).toEqual({ Tú: "16.50", Pedro: "16.50" });
    expect(r?.mode === "items" && r.extras.toFixed(2)).toBe("3.00");
  });

  it("a medias, por unidades y el resto entre todos", () => {
    const r = computeSplit(bill, {
      people: [
        // La pizza a medias; 2 de las 3 cervezas.
        {
          name: "Tú",
          isMe: true,
          items: [
            { index: 1, units: 0 },
            { index: 3, units: 2 },
          ],
        },
        {
          name: "Pedro",
          isMe: false,
          items: [
            { index: 1, units: 0 },
            { index: 2, units: 0 },
            { index: 3, units: 1 },
          ],
        },
      ],
      sharedByAll: [4],
      equalSplit: 0,
    });
    // Tú: 6 + 4 + 1,5 = 11,5 → +10 % = 12,65. Pedro: 6 + 9 + 2 + 1,5 = 18,5 → 20,35.
    expect(totals(r)).toEqual({ Tú: "12.65", Pedro: "20.35" });
    const me = r?.mode === "items" ? r.people[0] : null;
    expect(me?.items.map((i) => [i.name, i.shared])).toEqual([
      ["Pizza margarita", true],
      ["Cerveza", false],
      ["Postre", true],
    ]);
  });

  it("lo que nadie nombró queda sin asignar, con su parte del servicio", () => {
    const r = computeSplit(bill, {
      people: [{ name: "Tú", isMe: true, items: [{ index: 1, units: 0 }] }],
      sharedByAll: [],
      equalSplit: 0,
    });
    expect(totals(r)).toEqual({ Tú: "13.20" });
    expect(r?.mode === "items" && r.unassigned.map((u) => [u.index, u.amount.toFixed(2)])).toEqual([
      [2, "9.90"],
      [3, "6.60"],
      [4, "3.30"],
    ]);
  });

  it("partes iguales; índices fuera de la lista no cuentan; sin reparto, null", () => {
    const eq = computeSplit(bill, { people: [], sharedByAll: [], equalSplit: 4 });
    expect(eq).toEqual({
      mode: "equal",
      parts: 4,
      each: new Decimal("8.25"),
      total: new Decimal("33.00"),
    });
    const bad = computeSplit(bill, {
      people: [
        {
          name: "Tú",
          isMe: true,
          items: [
            { index: 9, units: 0 },
            { index: 2, units: 0 },
          ],
        },
      ],
      sharedByAll: [],
      equalSplit: 0,
    });
    expect(totals(bad)).toEqual({ Tú: "9.90" });
    expect(computeSplit(bill, { people: [], sharedByAll: [], equalSplit: 0 })).toBeNull();
  });
});
