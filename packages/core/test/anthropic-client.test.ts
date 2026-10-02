import { describe, expect, it } from "vitest";
import { AnthropicLlmClient } from "../src/agent/anthropic";
import { costFor } from "../src/agent/pricing";

/** Caché de 1 hora (02/10): forma de la petición y precio de la escritura. */
function capture() {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [{ type: "tool_use", id: "t1", name: "get_bcv_rate", input: {} }],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: {
          input_tokens: 40,
          output_tokens: 20,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 5000,
          cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 5000 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { bodies, fetchImpl };
}

const request = {
  system: [
    { text: "global", cache: true },
    { text: "tenant", cache: true },
  ],
  turns: [{ role: "user" as const, text: "tasa?" }],
  tools: [{ name: "get_bcv_rate", description: "tasa", inputSchema: { type: "object" } }],
  maxTokens: 100,
  timeoutMs: 5_000,
};

describe("cliente de Anthropic: caché del prompt", () => {
  it("por defecto marca los bloques de sistema con TTL de 1 hora y lee las escrituras de 1 hora", async () => {
    const { bodies, fetchImpl } = capture();
    const llm = new AnthropicLlmClient({ apiKey: "test", fetch: fetchImpl });
    const res = await llm.complete(request);
    const system = bodies[0]?.system as { cache_control?: unknown }[];
    expect(system.map((b) => b.cache_control)).toEqual([
      { type: "ephemeral", ttl: "1h" },
      { type: "ephemeral", ttl: "1h" },
    ]);
    expect(res.usage).toMatchObject({ cacheWriteTokens: 5000, cacheWrite1hTokens: 5000 });
  });

  it("con cacheTtl 5m vuelve al caché corto", async () => {
    const { bodies, fetchImpl } = capture();
    const llm = new AnthropicLlmClient({ apiKey: "test", fetch: fetchImpl, cacheTtl: "5m" });
    await llm.complete(request);
    const system = bodies[0]?.system as { cache_control?: unknown }[];
    expect(system.map((b) => b.cache_control)).toEqual([
      { type: "ephemeral" },
      { type: "ephemeral" },
    ]);
  });

  it("la escritura de 1 hora cuesta el doble de la entrada; la de 5 minutos, 1,25 veces", () => {
    const base = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    // Sonnet 5.5: entrada 2 USD/M → 1h a 4 USD/M, 5m a 2,50 USD/M.
    expect(
      costFor("claude-sonnet-5-5", {
        ...base,
        cacheWriteTokens: 1_000_000,
        cacheWrite1hTokens: 1_000_000,
      }).toString(),
    ).toBe("4");
    expect(costFor("claude-sonnet-5-5", { ...base, cacheWriteTokens: 1_000_000 }).toString()).toBe(
      "2.5",
    );
    expect(
      costFor("claude-sonnet-5-5", {
        ...base,
        cacheWriteTokens: 1_000_000,
        cacheWrite1hTokens: 400_000,
      }).toString(),
    ).toBe("3.1");
  });
});
