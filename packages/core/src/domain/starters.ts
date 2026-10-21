/**
 * Las cinco cuentas de arranque: el asistente web y la pregunta del bot (PRD cash-in-drawer
 * US-006) ofrecen las mismas. Ids estables: van en los botones (`paynew:`) y en el asistente.
 * Aquí, sin base de datos, para que la web las use también en el navegador.
 */
export const STARTER_ACCOUNTS = [
  { id: "cash_usd", name: "Efectivo $", currency: "USD", kind: "cash" },
  { id: "cash_ves", name: "Efectivo Bs", currency: "VES", kind: "cash" },
  { id: "bank_ves", name: "Banco", currency: "VES", kind: "bank" },
  { id: "zelle", name: "Zelle", currency: "USD", kind: "zelle" },
  { id: "binance", name: "Binance", currency: "USD", kind: "crypto" },
] as const;
export type StarterAccount = (typeof STARTER_ACCOUNTS)[number];
export type StarterId = StarterAccount["id"];
