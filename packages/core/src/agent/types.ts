import type { Tx } from "@caja/db";
import type { PaymentDest } from "../billing/renew";
import type { IsoDate } from "../domain/dates";
import type { AccountRef } from "../ledger/accounts";
import type { Outbound } from "../render/outbound";
import type { ReceiptExtraction } from "../vision/receipt";

export type AgentContext = {
  tenantId: string;
  tenantName: string;
  phoneId: string;
  role: "owner" | "employee";
  defaultCurrency: "USD" | "VES" | null;
  vesThreshold: string;
  categories: { id: string; name: string }[];
  /** Cuenta personal (19/10): lo que entra son ingresos por fuente, no ventas. */
  personal?: boolean;
  /** Fuentes de ingreso activas de una cuenta personal (Salario, Freelance…). */
  incomeCategories?: { id: string; name: string }[];
  /** Cómo categoriza este negocio sus gastos recientes (16/10): la IA los sigue en gastos parecidos. */
  categoryExamples?: { description: string; category: string }[];
  today: IsoDate;
  /** Id de fila en `message` del mensaje entrante (para `movement.source_message_id`). */
  sourceMessageDbId: string | null;
  /** Id de WhatsApp del mensaje entrante, para responder con una reacción (🗑️ al borrar un recordatorio). */
  sourceWaMessageId?: string | null;
  sourceChannel: "text" | "voice" | "image";
  /** Foto de factura ya guardada (provisional) que el borrador de gasto debe llevar. */
  attachmentId: string | null;
  /** Enlace al dashboard para cierres y resúmenes. */
  dashboardUrl: string;
  /** De dónde sale la tasa de los gastos en Bs (0012): BCV, los cambios USDT o preguntar. */
  bsRateMode?: "bcv" | "usdt" | "ask";
  /** Cuentas activas del negocio (0013), en el orden del dueño; vacío si no usa cuentas. */
  accounts?: AccountRef[];
  /**
   * Negocio con al menos una cuenta de efectivo activa (PRD cash-in-drawer US-003): la cuenta se
   * elige en orden (dicha, la única posible, la de siempre) y si no se sabe, la tarjeta pregunta.
   * Sin esto, la principal de la moneda como siempre.
   */
  asksAccount?: boolean;
  /** Datos de cobro para renovar el plan por el bot (03/10). */
  billing?: { dest: PaymentDest; supportHint: string | null };
  /** Recordatorios (hábitos P3): solo con `habits.reminders` encendido. Sin esto, no hay herramientas. */
  reminders?: AgentReminders;
};

/** Un recordatorio abierto como lo ve el agente: `ref` ("r1"…) en vez del id. */
export type ReminderRef = {
  ref: string;
  id: string;
  text: string | null;
  kind: "pay" | "collect" | "other_money";
  amount: string | null;
  currency: "USD" | "VES" | "EUR" | null;
  counterparty: string | null;
  dueAt: Date;
  timeWasDefault: boolean;
};

export type AgentReminders = {
  /** Los pendientes más próximos del negocio (≤ 10); vacío para un empleado. */
  open: ReminderRef[];
  /** El que el dueño está corrigiendo (tocó Corregir, H15b). */
  fixing: ReminderRef | null;
  /**
   * Entregados a este teléfono en las últimas 12 h y sin cumplir (`ref` "d1"…): un gasto o un
   * ingreso que los cumple los cierra (US-307). Vacío para un empleado (F3-5).
   */
  delivered: ReminderRef[];
  pending: number;
  limit: number;
  trial: boolean;
};

/**
 * La respuesta a "no pude leer bien la factura" (03/10): lo poco que se leyó, para que el agente
 * arme el borrador con lo que escriba el usuario sin volver a preguntar.
 */
export type UnclearReceipt = {
  total: string | null;
  currency: string | null;
  vendor: string | null;
  documentType: "expense" | "sales" | "unknown";
  /**
   * `pago_movil`: la foto eran datos de pago móvil sin monto. `receipt_question`: la factura se
   * leyó bien pero el agente preguntó algo (la fecha, la moneda). 03/10.
   */
  source?: "receipt" | "pago_movil" | "receipt_question";
};

export type AgentInput =
  | {
      kind: "text";
      text: string;
      afterUnclearReceipt?: UnclearReceipt | null;
      /** El mensaje anterior fue una foto o PDF (hace menos de 2 min): puede ser su descripción. */
      afterMedia?: boolean;
    }
  /** Transcripción de una nota de voz: se trata como texto, pero el movimiento lleva canal `voice`. */
  | { kind: "voice"; text: string; afterUnclearReceipt?: UnclearReceipt | null }
  /** Lectura estructurada de una foto de factura: el loop la convierte en texto para el modelo. */
  | { kind: "receipt"; extracted: ReceiptExtraction; caption?: string | null };

export type AgentResult = {
  outbound: Outbound[];
  toolCalls: { name: string; args: unknown }[];
  tokensIn: number;
  tokensOut: number;
  costUsd: string | null;
  status: "ok" | "failed" | "rejected_out_of_scope";
};

/** El agente. Corre dentro de la transacción del tenant: sus herramientas crean borradores. */
export interface AgentRunner {
  run(tx: Tx, ctx: AgentContext, input: AgentInput): Promise<AgentResult>;
}
