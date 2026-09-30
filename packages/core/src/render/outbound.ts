import type { Button, ListSection } from "../whatsapp/client";

/** Mensaje saliente ya decidido, independiente del transporte. Lo envía el worker con MetaClient. */
export type Outbound =
  | { type: "text"; body: string }
  | { type: "buttons"; body: string; buttons: Button[]; footer?: string }
  | { type: "list"; body: string; buttonLabel: string; sections: ListSection[]; header?: string }
  /** Reacción sobre un mensaje del usuario: gratis y no gasta el cupo de servicio (ADR-014). `body` es el emoji. */
  | { type: "reaction"; body: string; waMessageId: string };

/**
 * Junta dos mensajes en uno (ADR-014: una respuesta = un mensaje). El cuerpo del primero va
 * arriba; los botones o la lista del segundo mandan. Una reacción no se fusiona.
 */
export function mergeOutbound(first: Outbound, second: Outbound): Outbound[] {
  if (first.type === "reaction" || second.type === "reaction") return [first, second];
  const body = `${first.body}\n\n${second.body}`;
  if (second.type === "text" && first.type !== "text") return [{ ...first, body }];
  return [{ ...second, body }];
}

/** Ids de botones y filas. El handler determinista enruta por prefijo, nunca por el título. */
export const IDS = {
  menuExpense: "menu:expense",
  menuIncome: "menu:income",
  menuClose: "menu:close",
  confirm: (pendingId: string) => `confirm:${pendingId}`,
  fix: (pendingId: string) => `fix:${pendingId}`,
  cancel: (pendingId: string) => `cancel:${pendingId}`,
  /** Decisiones sobre un borrador que no son Guardar/Corregir/Cancelar (desglose, día ya cerrado). */
  choice: (pendingId: string, key: ChoiceKey) => `choice:${key}:${pendingId}`,
  currency: (c: "USD" | "VES") => `currency:${c}`,
  category: (categoryId: string) => `cat:${categoryId}`,
} as const;

export const CHOICE_KEYS = ["stated", "breakdown", "replace", "append"] as const;
export type ChoiceKey = (typeof CHOICE_KEYS)[number];

export type ParsedReplyId =
  | { kind: "menu"; action: "expense" | "income" | "close" }
  | { kind: "confirm" | "fix" | "cancel"; pendingId: string }
  | { kind: "choice"; key: ChoiceKey; pendingId: string }
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
    case "choice": {
      const [key, ...idParts] = rest;
      const pendingId = idParts.join(":");
      if ((CHOICE_KEYS as readonly string[]).includes(key ?? "") && pendingId)
        return { kind: "choice", key: key as ChoiceKey, pendingId };
      break;
    }
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
