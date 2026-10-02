import Anthropic from "@anthropic-ai/sdk";
import type { Decimal } from "../domain/money";
import {
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  type LlmToolCall,
  type LlmTurn,
  LlmUnavailableError,
  type LlmUsage,
} from "./llm";
import { costFor } from "./pricing";

/**
 * Proveedor principal: Claude Sonnet 5.5 (Fase 6). Reglas del modelo que aplican aquí:
 * - El razonamiento no se desactiva; se controla con `output_config.effort: "low"`.
 * - No hay `tool_choice` forzado: se guía por prompt y el loop verifica que haya tool_use.
 * - `strict: true` en cada herramienta para argumentos válidos según esquema.
 * - `fallbacks: "default"` (beta) para que una negativa por política reintente en un modelo
 *   sustituto dentro de la misma llamada.
 * - Caché de prompt: herramientas y bloques de sistema estables primero, breakpoint por bloque.
 *   TTL de 1 hora por defecto (02/10): con pocos mensajes, separados de 5 a 60 minutos, el caché
 *   de 5 minutos vencía entre uno y otro y casi cada turno pagaba la escritura. Todos los
 *   breakpoints llevan el mismo TTL (la API exige los de 1 hora antes que los de 5 minutos).
 */
export type AnthropicClientOptions = {
  apiKey?: string;
  model?: string;
  effort?: "low" | "medium" | "high";
  maxRetries?: number;
  /** TTL del caché del prompt; "1h" por defecto. */
  cacheTtl?: "5m" | "1h";
  /** Solo para pruebas: intercepta las llamadas HTTP. */
  fetch?: typeof fetch;
};

export class AnthropicLlmClient implements LlmClient {
  readonly model: string;
  readonly #client: Anthropic;
  readonly #effort: "low" | "medium" | "high";
  readonly cacheTtl: "5m" | "1h";

  constructor(opts: AnthropicClientOptions = {}) {
    this.model = opts.model ?? "claude-sonnet-5-5";
    this.#effort = opts.effort ?? "low";
    this.cacheTtl = opts.cacheTtl ?? "1h";
    this.#client = new Anthropic({
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      maxRetries: opts.maxRetries ?? 1,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  costUsd(usage: LlmUsage): Decimal {
    return costFor(this.model, usage);
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      strict: true,
      input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
    }));
    const system = req.system.map((b) => ({
      type: "text" as const,
      text: b.text,
      ...(b.cache
        ? {
            cache_control:
              this.cacheTtl === "1h"
                ? { type: "ephemeral" as const, ttl: "1h" as const }
                : { type: "ephemeral" as const },
          }
        : {}),
    }));
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.#client.beta.messages.create(
        {
          model: this.model,
          max_tokens: req.maxTokens,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: this.#effort },
          system,
          tools,
          messages: toMessages(req.turns),
        },
        { timeout: req.timeoutMs },
      );
    } catch (err) {
      if (err instanceof Anthropic.BadRequestError) {
        // Un 400 es un error nuestro (esquema, parámetros), no una caída: que se vea en logs.
        throw new LlmUnavailableError(`Anthropic 400: ${err.message}`, err);
      }
      if (err instanceof Anthropic.APIError) {
        throw new LlmUnavailableError(`Anthropic ${err.status ?? "?"}: ${err.message}`, err);
      }
      throw new LlmUnavailableError(err instanceof Error ? err.message : String(err), err);
    }

    const toolCalls: LlmToolCall[] = [];
    const texts: string[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use")
        toolCalls.push({ id: block.id, name: block.name, input: block.input });
      else if (block.type === "text" && block.text.trim()) texts.push(block.text);
    }
    const stop = response.stop_reason;
    return {
      toolCalls,
      text: texts.length ? texts.join("\n") : null,
      stopReason:
        stop === "tool_use" || stop === "end_turn" || stop === "max_tokens" || stop === "refusal"
          ? stop
          : "other",
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
        cacheWrite1hTokens: response.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      },
      model: response.model,
    };
  }
}

function toMessages(turns: LlmTurn[]): Anthropic.Beta.BetaMessageParam[] {
  const out: Anthropic.Beta.BetaMessageParam[] = [];
  for (const t of turns) {
    if (t.role === "user") {
      if (t.image) {
        out.push({
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: t.image.mimeType as
                  | "image/jpeg"
                  | "image/png"
                  | "image/webp"
                  | "image/gif",
                data: Buffer.from(t.image.data).toString("base64"),
              },
            },
            { type: "text", text: t.text },
          ],
        });
      } else out.push({ role: "user", content: t.text });
    } else if (t.role === "assistant") {
      const content: Anthropic.Beta.BetaContentBlockParam[] = [];
      if (t.text) content.push({ type: "text", text: t.text });
      for (const c of t.toolCalls)
        content.push({
          type: "tool_use",
          id: c.id,
          name: c.name,
          input: c.input as Record<string, unknown>,
        });
      if (content.length) out.push({ role: "assistant", content });
    } else {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: t.toolUseId,
            content: t.content,
            ...(t.isError ? { is_error: true } : {}),
          },
        ],
      });
    }
  }
  return out;
}
