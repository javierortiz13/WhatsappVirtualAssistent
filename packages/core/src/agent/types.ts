import type { Tx } from "@caja/db";
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
};

export type AgentInput =
  | { kind: "text"; text: string }
  /** Transcripción de una nota de voz: se trata como texto, pero el movimiento lleva canal `voice`. */
  | { kind: "voice"; text: string }
  /** Lectura estructurada de una foto de factura: el loop la convierte en texto para el modelo. */
  | { kind: "receipt"; extracted: ReceiptExtraction };

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
