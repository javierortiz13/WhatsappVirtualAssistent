import type { Decimal } from "../domain/money";

/**
 * Interfaz mínima sobre un proveedor de LLM con tool-calling (ADR-008). Solo lo que el agente
 * usa: turnos, herramientas con esquema JSON, y la respuesta con llamadas a herramienta y uso.
 * Un segundo proveedor (Gemini) implementa esto mismo sin tocar el loop.
 */
export type LlmToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type LlmToolCall = { id: string; name: string; input: unknown };

export type LlmTurn =
  /** `image` solo en la lectura de facturas: un turno con la foto y la instrucción. */
  | { role: "user"; text: string; image?: { mimeType: string; data: Uint8Array } }
  | { role: "assistant"; text: string | null; toolCalls: LlmToolCall[] }
  | { role: "tool_result"; toolUseId: string; content: string; isError?: boolean };

export type LlmRequest = {
  /** Bloques de sistema en orden de estabilidad: el primero nunca cambia, el último es por tenant. */
  system: { text: string; cache: boolean }[];
  turns: LlmTurn[];
  tools: LlmToolDef[];
  maxTokens: number;
  timeoutMs: number;
};

export type LlmUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Tokens escritos al caché, de cualquier TTL (incluye los de 1 hora). */
  cacheWriteTokens: number;
  /** Parte de `cacheWriteTokens` escrita con TTL de 1 hora (se cobra al doble del precio base). */
  cacheWrite1hTokens?: number;
};

export type LlmResponse = {
  toolCalls: LlmToolCall[];
  text: string | null;
  stopReason: "tool_use" | "end_turn" | "max_tokens" | "refusal" | "other";
  usage: LlmUsage;
  model: string;
};

export interface LlmClient {
  readonly model: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
  costUsd(usage: LlmUsage): Decimal;
}

/** El proveedor no respondió o respondió con error: el agente informa y no reintenta escrituras. */
export class LlmUnavailableError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}
