import { ACCOUNT_KIND_LABELS, type AccountView, type Decimal, formatMoney } from "@caja/core";

/** "Bs 12.300,00", "$40,00" o "85,00 USDT". */
export function accountMoney(a: Pick<AccountView, "currency" | "kind">, v: Decimal): string {
  if (a.currency === "USD" && a.kind === "crypto")
    return `${formatMoney(v, "USD").replace("$", "")} USDT`;
  return formatMoney(v, a.currency);
}

/** "Banco · Bs", "Efectivo · $", "USDT". */
export function accountKindLine(a: Pick<AccountView, "currency" | "kind">): string {
  if (a.currency === "USD" && a.kind === "crypto") return "USDT";
  return `${ACCOUNT_KIND_LABELS[a.kind]} · ${a.currency === "VES" ? "Bs" : "$"}`;
}
