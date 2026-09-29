import type { IsoDate } from "../domain/dates.js";
import type { Outbound } from "../render/outbound.js";

export type AgentContext = {
  tenantId: string;
  tenantName: string;
  phoneId: string;
  role: "owner" | "employee";
  defaultCurrency: "USD" | "VES" | null;
  today: IsoDate;
  waMessageId: string;
};

export type AgentInput =
  | { kind: "text"; text: string; sourceChannel: "text" | "voice" }
  | { kind: "receipt"; extracted: Record<string, unknown>; sourceChannel: "image" };

export type AgentResult = {
  outbound: Outbound[];
  /** Para `message.tool_calls` y métricas. */
  toolCalls: { name: string; args: unknown }[];
  tokensIn: number;
  tokensOut: number;
  costUsd: string | null;
  status: "ok" | "failed" | "rejected_out_of_scope";
};

/** El agente (día 5). Recibe contexto y entrada, devuelve mensajes ya renderizados. */
export interface AgentRunner {
  run(ctx: AgentContext, input: AgentInput): Promise<AgentResult>;
}
