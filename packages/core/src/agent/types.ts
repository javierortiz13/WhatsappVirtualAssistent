import type { Tx } from "@caja/db";
import type { PaymentDest } from "../billing/renew";
import type { IsoDate } from "../domain/dates";
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
  today: IsoDate;
  /** Id de fila en `message` del mensaje entrante (para `movement.source_message_id`). */
  sourceMessageDbId: string | null;
  sourceChannel: "text" | "voice" | "image";
  /** Foto de factura ya guardada (provisional) que el borrador de gasto debe llevar. */
  attachmentId: string | null;
  /** Enlace al dashboard para cierres y resúmenes. */
  dashboardUrl: string;
  /** Datos de cobro para renovar el plan por el bot (03/10). */
  billing?: { dest: PaymentDest; supportHint: string | null };
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
