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
  /** Renovar el plan: método elegido para un plan y meses (03/10). */
  renew: (method: RenewMethod, plan: string, months: number) => `renew:${method}:${plan}:${months}`,
  /** Ya pagó y mandó la referencia sin haber elegido método: un toque y queda reportado. */
  renewRef: (method: RenewMethod, reference: string) => `renewref:${method}:${reference}`,
  /** De dónde sale la tasa de los gastos en Bs (0012): BCV, los cambios USDT o preguntar. */
  bsMode: (mode: BsMode) => `bsmode:${mode}`,
  /** Confirmar o no "eliminar mi cuenta" (0017). */
  erase: (answer: "yes" | "no") => `erase:${answer}`,
  /** Registro por WhatsApp (0018): "signup:kind:personal", "signup:cur:USD", "signup:type:food"… */
  signup: (value: string) => `signup:${value}`,
  /** Encuesta del día 10 y resumen del día 12 (0019): "survey:fair:5-8", "survey:continue:yes". */
  survey: (question: string, answer: string) => `survey:${question}:${answer}`,
} as const;

export const BS_MODES = ["bcv", "usdt", "ask"] as const;
export type BsMode = (typeof BS_MODES)[number];

export const RENEW_METHODS = ["pago_movil", "zelle", "binance"] as const;
export type RenewMethod = (typeof RENEW_METHODS)[number];
const isRenewMethod = (v: string | undefined): v is RenewMethod =>
  (RENEW_METHODS as readonly string[]).includes(v ?? "");

/** usdt / bcv: respuesta a "¿De dónde salieron estos Bs?" sobre un borrador de gasto (0012). */
export const CHOICE_KEYS = ["stated", "breakdown", "replace", "append", "usdt", "bcv"] as const;
export type ChoiceKey = (typeof CHOICE_KEYS)[number];

export type ParsedReplyId =
  | { kind: "menu"; action: "expense" | "income" | "close" }
  | { kind: "confirm" | "fix" | "cancel"; pendingId: string }
  | { kind: "choice"; key: ChoiceKey; pendingId: string }
  | { kind: "currency"; currency: "USD" | "VES" }
  | { kind: "category"; categoryId: string }
  | { kind: "renew"; method: RenewMethod; plan: string; months: number }
  | { kind: "renew_ref"; method: RenewMethod; reference: string }
  | { kind: "bs_mode"; mode: BsMode }
  | { kind: "erase"; answer: "yes" | "no" }
  | { kind: "signup"; value: string }
  | { kind: "survey"; question: "fair" | "expensive" | "continue"; answer: string }
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
      // Un id que no es UUID haría fallar la consulta en Postgres (y el job dos veces).
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
        return { kind: "category", categoryId: value };
      break;
    case "renew": {
      const [method, plan, months] = rest;
      const n = Number(months);
      if (isRenewMethod(method) && plan && Number.isInteger(n) && n >= 1 && n <= 12)
        return { kind: "renew", method, plan, months: n };
      break;
    }
    case "renewref": {
      const [method, ...refParts] = rest;
      const reference = refParts.join(":");
      if (isRenewMethod(method) && /^[A-Z0-9-]{4,30}$/i.test(reference))
        return { kind: "renew_ref", method, reference };
      break;
    }
    case "erase":
      if (value === "yes" || value === "no") return { kind: "erase", answer: value };
      break;
    case "signup":
      if (value) return { kind: "signup", value };
      break;
    case "survey": {
      const [question, answer] = rest;
      if (
        (question === "fair" || question === "expensive" || question === "continue") &&
        answer &&
        /^[a-z0-9-]{1,12}$/.test(answer)
      )
        return { kind: "survey", question, answer };
      break;
    }
    case "bsmode":
      if ((BS_MODES as readonly string[]).includes(value))
        return { kind: "bs_mode", mode: value as BsMode };
      break;
    default:
      break;
  }
  return { kind: "unknown", raw };
}
