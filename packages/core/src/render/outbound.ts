import type { Button, ListSection } from "../whatsapp/client";

/** Mensaje saliente ya decidido, independiente del transporte. Lo envía el worker con MetaClient. */
export type Outbound =
  | { type: "text"; body: string }
  | { type: "buttons"; body: string; buttons: Button[]; footer?: string }
  | { type: "list"; body: string; buttonLabel: string; sections: ListSection[]; header?: string };

/** Ids de botones y filas. El handler determinista enruta por prefijo, nunca por el título. */
export const IDS = {
  menuExpense: "menu:expense",
  menuIncome: "menu:income",
  menuClose: "menu:close",
  confirm: (pendingId: string) => `confirm:${pendingId}`,
  fix: (pendingId: string) => `fix:${pendingId}`,
  cancel: (pendingId: string) => `cancel:${pendingId}`,
  currency: (c: "USD" | "VES") => `currency:${c}`,
  category: (categoryId: string) => `cat:${categoryId}`,
} as const;

export type ParsedReplyId =
  | { kind: "menu"; action: "expense" | "income" | "close" }
  | { kind: "confirm" | "fix" | "cancel"; pendingId: string }
  | { kind: "currency"; currency: "USD" | "VES" }
  | { kind: "category"; categoryId: string }
  | { kind: "unknown"; raw: string };

export function parseReplyId(raw: string): ParsedReplyId {
  const [prefix, ...rest] = raw.split(":");
  const value = rest.join(":");
  switch (prefix) {
    case "menu":
      if (value === "expense" || value === "income" || value === "close")
        return { kind: "menu", action: value };
      break;
    case "confirm":
    case "fix":
    case "cancel":
      if (value) return { kind: prefix, pendingId: value };
      break;
    case "currency":
      if (value === "USD" || value === "VES") return { kind: "currency", currency: value };
      break;
    case "cat":
      if (value) return { kind: "category", categoryId: value };
      break;
    default:
      break;
  }
  return { kind: "unknown", raw };
}
