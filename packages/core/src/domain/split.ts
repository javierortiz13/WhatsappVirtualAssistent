import { Decimal } from "./money";

/**
 * Dividir una cuenta (06/10, pedido de Javier): con los renglones leídos de la factura y quién
 * consumió qué, cuánto paga cada quien. El modelo solo lee y reparte índices; la cuenta la hace
 * esta función con Decimal. Lo que la factura cobra aparte de los renglones (IVA, servicio,
 * propina o un descuento) se reparte en proporción a lo que consumió cada uno.
 */
export type BillItem = { name: string; quantity: number; amount: Decimal };
export type Bill = {
  vendor: string;
  currency: "USD" | "VES";
  items: BillItem[];
  /** Total de la factura; null si no se leyó (se usa la suma de los renglones). */
  total: Decimal | null;
};

export type SplitAssignment = {
  people: { name: string; isMe: boolean; items: { index: number; units: number }[] }[];
  /** Renglones (1..N) que se reparten entre todos. */
  sharedByAll: number[];
  /** Partes iguales entre N personas (sin renglones por persona); 0 si no. */
  equalSplit: number;
};

export type SplitShare = {
  name: string;
  isMe: boolean;
  items: { name: string; amount: Decimal; shared: boolean }[];
  subtotal: Decimal;
  extra: Decimal;
  total: Decimal;
};

export type SplitResult =
  | { mode: "equal"; parts: number; each: Decimal; total: Decimal }
  | {
      mode: "items";
      people: SplitShare[];
      unassigned: { index: number; name: string; amount: Decimal }[];
      /** IVA, servicio o propina (positivo) o descuento (negativo) repartido. */
      extras: Decimal;
      total: Decimal;
    };

const r2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

export function billTotal(bill: Bill): Decimal {
  return bill.total ?? bill.items.reduce((s, i) => s.plus(i.amount), new Decimal(0));
}

export function computeSplit(bill: Bill, a: SplitAssignment): SplitResult | null {
  const total = billTotal(bill);
  const named = a.people.filter((p) => p.items.length > 0 || a.sharedByAll.length > 0);
  if (a.equalSplit >= 2 && !a.people.some((p) => p.items.length)) {
    const parts = Math.min(Math.floor(a.equalSplit), 100);
    return { mode: "equal", parts, each: r2(total.div(parts)), total };
  }
  if (!named.length) return null;
  const n = bill.items.length;
  const valid = (i: number) => Number.isInteger(i) && i >= 1 && i <= n;
  const shares: SplitShare[] = named.map((p) => ({
    name: p.name,
    isMe: p.isMe,
    items: [],
    subtotal: new Decimal(0),
    extra: new Decimal(0),
    total: new Decimal(0),
  }));
  const unassigned: { index: number; name: string; amount: Decimal }[] = [];
  bill.items.forEach((item, k) => {
    const index = k + 1;
    const claims = named.flatMap((p, pi) =>
      p.items
        .filter((x) => x.index === index && valid(x.index))
        .map((x) => ({ pi, units: Math.max(0, x.units) })),
    );
    if (!claims.length && a.sharedByAll.includes(index))
      for (let pi = 0; pi < named.length; pi++) claims.push({ pi, units: 0 });
    if (!claims.length) {
      unassigned.push({ index, name: item.name, amount: item.amount });
      return;
    }
    // Unidades contadas ("yo 2 de las 3 cervezas") primero; lo que quede, a partes iguales
    // entre los que lo comparten sin cantidad.
    const qty = item.quantity > 0 ? item.quantity : 1;
    const unitPrice = item.amount.div(qty);
    const counted = claims.filter((c) => c.units > 0 && qty > 1);
    const even = claims.filter((c) => !(c.units > 0 && qty > 1));
    let left = item.amount;
    for (const c of counted) {
      const part = Decimal.min(left, unitPrice.mul(Math.min(c.units, qty)));
      left = left.minus(part);
      add(c.pi, part, false);
    }
    if (even.length && left.gt(0)) {
      const part = left.div(even.length);
      for (const c of even) add(c.pi, part, even.length > 1 || counted.length > 0);
      left = new Decimal(0);
    }
    if (left.gt("0.004")) unassigned.push({ index, name: item.name, amount: left });
    function add(pi: number, amount: Decimal, shared: boolean) {
      const s = shares[pi];
      if (!s) return;
      s.items.push({ name: item.name, amount, shared });
      s.subtotal = s.subtotal.plus(amount);
    }
  });
  const itemsSum = bill.items.reduce((s, i) => s.plus(i.amount), new Decimal(0));
  const extras = itemsSum.gt(0) ? total.minus(itemsSum) : new Decimal(0);
  for (const s of shares) {
    s.extra = itemsSum.gt(0) ? extras.mul(s.subtotal).div(itemsSum) : new Decimal(0);
    s.total = r2(s.subtotal.plus(s.extra));
    s.subtotal = r2(s.subtotal);
    s.extra = r2(s.extra);
  }
  return {
    mode: "items",
    people: shares.filter((s) => s.items.length > 0),
    unassigned: unassigned.map((u) => ({
      ...u,
      amount: r2(itemsSum.gt(0) ? u.amount.plus(extras.mul(u.amount).div(itemsSum)) : u.amount),
    })),
    extras: r2(extras),
    total: r2(total),
  };
}
