import { schema, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient } from "../src/agent/llm";
import { createAgent } from "../src/agent/loop";
import { Decimal } from "../src/domain/money";
import { ingestWebhook } from "../src/inbox/ingest";
import { AUDIO_MAX_BYTES, type ProcessDeps, processInbound } from "../src/inbox/process";
import type { SpeechClient, Transcript } from "../src/speech/client";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/** Nota de voz de punta a punta (US-B5): acuse 🎧, descarga, transcripción y borrador en un envío. */
type Sent = { body: Record<string, unknown> };

function fakeMeta(audioBytes = 1000) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/MEDIA_AUDIO"))
      return Response.json({
        id: "MEDIA_AUDIO",
        url: "https://lookaside.test/media/1",
        mime_type: "audio/ogg",
        file_size: audioBytes,
      });
    if (u.startsWith("https://lookaside.test/"))
      return new Response(new Uint8Array(audioBytes), {
        status: 200,
        headers: { "content-type": "audio/ogg", "content-length": String(audioBytes) },
      });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (body.status !== "read") sent.push({ body });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT.${Math.random()}` }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    sent,
    client: new MetaClient({ accessToken: "T", phoneNumberId: fx.PHONE_NUMBER_ID, fetchImpl }),
  };
}

const textOf = (s: Sent | undefined) =>
  String(
    (s?.body.text as { body?: string } | undefined)?.body ??
      (s?.body.interactive as { body?: { text?: string } } | undefined)?.body?.text ??
      "",
  );

function fakeSpeech(result: Transcript | Error): SpeechClient & { calls: number } {
  return {
    provider: "fake",
    calls: 0,
    async transcribe() {
      this.calls += 1;
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const llm: LlmClient = {
  model: "fake",
  async complete(req) {
    const last = req.turns[req.turns.length - 1];
    const text = last && "text" in last ? (last.text ?? "") : "";
    const input = text.includes("veinte dólares")
      ? {
          amount: "20",
          currency: "USD",
          description: "Comida de los muchachos",
          category_name: "",
          when: "",
          rate: "",
          corrects_draft: false,
        }
      : null;
    return {
      toolCalls: input
        ? [{ id: "v1", name: "draft_expense", input }]
        : [
            {
              id: "v2",
              name: "ask_clarification",
              input: { question: "¿Cuánto fue?", options: [] },
            },
          ],
      text: null,
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: "fake",
    };
  },
  costUsd: () => new Decimal(0),
};

describe("notas de voz", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  const now = () => new Date("2026-09-29T15:00:00Z");
  const jobs: ProcessMessageJob[] = [];
  let seq = 0;

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Autolavado",
      businessType: "car_wash",
      ownerPhone: "584121234567",
    });
    await t.db
      .insert(schema.bcvRate)
      .values({ effectiveDate: "2026-09-29", rate: "858.00000000", source: "test" });
  });
  afterAll(() => t.close());

  function deps(client: MetaClient, speech: SpeechClient | null): ProcessDeps {
    return {
      db: t.db,
      metaFor: () => client,
      agent: createAgent({ llm, now }),
      speech,
      now,
      config: {
        assistantName: "x",
        dashboardUrl: "https://caja.test",
        supportHint: null,
        unknownReplyMax: 5,
        unknownReplyWindowMs: 3_600_000,
        maxEventAgeMs: 12 * 3_600_000,
        maxTextLength: 500,
      },
    };
  }

  async function sendAudio(client: MetaClient, speech: SpeechClient | null) {
    jobs.length = 0;
    const p = JSON.parse(JSON.stringify(fx.audioMessage));
    p.entry[0].changes[0].value.messages[0].id = `wamid.VOICE${++seq}`;
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    return processInbound(deps(client, speech), jobs[0] as ProcessMessageJob);
  }

  it("transcribe, acusa con 🎧 y manda la transcripción con el borrador en un solo mensaje", async () => {
    const { sent, client } = fakeMeta();
    const speech = fakeSpeech({
      text: "anota ahí veinte dólares de la comida de los muchachos",
      confidence: 0.9,
      durationSeconds: 6,
    });
    expect(await sendAudio(client, speech)).toBe("done");
    expect(speech.calls).toBe(1);
    expect(sent[0]?.body.type).toBe("reaction");
    expect(sent[0]?.body.reaction).toMatchObject({ emoji: "🎧" });
    expect(sent).toHaveLength(2);
    const body = textOf(sent[1]);
    // La transcripción sale una sola vez, dentro del borrador ("Entendí: …"), no también arriba.
    expect(body).toContain('Entendí: _"anota ahí veinte dólares de la comida de los muchachos"_');
    expect(body).not.toContain("🎤");
    expect(body).toContain("Gasto por confirmar");
    expect(body).toContain("*$20,00*");
    // La transcripción queda como cuerpo del mensaje entrante; el audio no se guarda.
    const rows = await withTenant(t.db, tenantId, (tx) => tx.select().from(schema.message));
    const audio = rows.find((m) => m.kind === "audio");
    expect(audio?.body).toBe("anota ahí veinte dólares de la comida de los muchachos");
    expect(rows.filter((m) => m.direction === "out")).toHaveLength(2);
  });

  it("sin monto en la transcripción: la transcripción más la pregunta del agente", async () => {
    const { sent, client } = fakeMeta();
    const speech = fakeSpeech({ text: "anota la comida", confidence: 0.8, durationSeconds: 3 });
    await sendAudio(client, speech);
    expect(textOf(sent[1])).toBe('🎤 "anota la comida"\n\n¿Cuánto fue?');
  });

  it("audio de más de 2 minutos o de más de 5 MB: pide una nota más corta", async () => {
    const long = fakeMeta();
    await sendAudio(long.client, fakeSpeech({ text: "x", confidence: 1, durationSeconds: 180 }));
    expect(textOf(long.sent[1])).toContain("menos de 2 minutos");
    const big = fakeMeta(AUDIO_MAX_BYTES + 1);
    const speech = fakeSpeech({ text: "x", confidence: 1, durationSeconds: 5 });
    await sendAudio(big.client, speech);
    expect(speech.calls).toBe(0);
    expect(textOf(big.sent[1])).toContain("menos de 2 minutos");
  });

  it("transcripción vacía o proveedor caído: pide que lo escriba", async () => {
    const empty = fakeMeta();
    await sendAudio(empty.client, fakeSpeech({ text: "", confidence: null, durationSeconds: 2 }));
    expect(textOf(empty.sent[1])).toContain("No pude escuchar bien");
    const down = fakeMeta();
    await sendAudio(down.client, fakeSpeech(new Error("deepgram 503")));
    expect(textOf(down.sent[1])).toContain("No pude escuchar bien");
  });

  it("sin cliente de voz: 'llegan pronto', sin acuse", async () => {
    const { sent, client } = fakeMeta();
    await sendAudio(client, null);
    expect(sent).toHaveLength(1);
    expect(textOf(sent[0])).toContain("Las notas de voz llegan pronto");
  });
});
