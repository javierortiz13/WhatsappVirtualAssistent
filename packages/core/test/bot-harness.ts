import { schema, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import type { LlmClient, LlmResponse } from "../src/agent/llm";
import { createAgent } from "../src/agent/loop";
import { Decimal } from "../src/domain/money";
import { ingestWebhook } from "../src/inbox/ingest";
import { type ProcessDeps, processInbound } from "../src/inbox/process";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/**
 * Un negocio de prueba con su dueño (y un cajero) y un bot de punta a punta: mensajes que entran
 * por el webhook y salen por un Meta falso. El LLM responde con un guion por frase.
 */
export const OWNER = "584121234567";
export const CASHIER = "584149876543";

export type Sent = { to: string; body: Record<string, unknown> };

export function scriptedLlm(
  script: Record<string, LlmResponse["toolCalls"]> = {},
): LlmClient & { calls: number; seen: string[] } {
  const llm = {
    calls: 0,
    seen: [] as string[],
    model: "claude-sonnet-5-5",
    async complete(req: Parameters<LlmClient["complete"]>[0]) {
      llm.calls += 1;
      const last = req.turns[req.turns.length - 1];
      const text = last && "text" in last ? (last.text ?? "") : "";
      llm.seen.push(text);
      const key = Object.keys(script).find((k) => text.includes(k));
      return {
        toolCalls: key
          ? (script[key] ?? [])
          : [{ id: "q", name: "ask_clarification", input: { question: "¿Qué?", options: [] } }],
        text: null,
        stopReason: "tool_use" as const,
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: "claude-sonnet-5-5",
      };
    },
    costUsd: () => new Decimal(0),
  };
  return llm;
}

export const textOf = (s: Sent | undefined) =>
  String(
    (s?.body.text as { body?: string } | undefined)?.body ??
      (s?.body.interactive as { body?: { text?: string } } | undefined)?.body?.text ??
      "",
  );
export const idsOf = (s: Sent | undefined): string[] => {
  const i = s?.body.interactive as
    | {
        action?: {
          buttons?: { reply: { id: string } }[];
          sections?: { rows: { id: string }[] }[];
        };
      }
    | undefined;
  return [
    ...(i?.action?.buttons?.map((b) => b.reply.id) ?? []),
    ...(i?.action?.sections?.flatMap((s) => s.rows.map((r) => r.id)) ?? []),
  ];
};

export async function botHarness(
  opts: {
    businessType?: string;
    script?: Record<string, LlmResponse["toolCalls"]>;
    now?: () => Date;
    /** H53 (US-200): el worker la enciende; los tests solo cuando la prueban. */
    privacyNotice?: boolean;
  } = {},
) {
  const t = await createTestDb();
  const tenantId = await seedTenant(t.db, {
    name: "Ana",
    businessType: opts.businessType ?? "food",
    ownerPhone: OWNER,
  });
  const now = opts.now ?? (() => new Date());
  await withTenant(t.db, tenantId, (tx) =>
    tx.insert(schema.phoneNumber).values({
      tenantId,
      e164: CASHIER,
      role: "employee",
      status: "active",
      verifiedAt: new Date(),
    }),
  );
  const llm = scriptedLlm(opts.script);
  const sent: Sent[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (body.status !== "read") sent.push({ to: String(body.to ?? ""), body });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT.${Math.random()}` }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const meta = new MetaClient({ accessToken: "T", phoneNumberId: fx.PHONE_NUMBER_ID, fetchImpl });
  const deps = (): ProcessDeps => ({
    db: t.db,
    metaFor: () => meta,
    agent: createAgent({ llm, now }),
    now,
    config: {
      assistantName: "Rocco",
      dashboardUrl: "https://caja.test",
      supportHint: null,
      privacyContact: "privacidad@caja.test",
      privacyNotice: opts.privacyNotice ?? false,
      unknownReplyMax: 50,
      unknownReplyWindowMs: 3_600_000,
      maxEventAgeMs: 12 * 3_600_000,
      maxTextLength: 500,
      captionWaitMs: 0,
    },
  });
  let seq = 0;
  async function deliver(payload: unknown, phone: string) {
    const p = payload as {
      entry: {
        changes: {
          value: { messages: { from: string; id: string }[]; contacts: { wa_id: string }[] };
        }[];
      }[];
    };
    const v = p.entry[0]?.changes[0]?.value;
    if (v?.messages[0]) {
      v.messages[0].from = phone;
      v.messages[0].id = `wamid.H${++seq}.${Math.random()}`;
    }
    if (v?.contacts[0]) v.contacts[0].wa_id = phone;
    const jobs: ProcessMessageJob[] = [];
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    await processInbound(deps(), jobs[0] as ProcessMessageJob);
    return sent.at(-1);
  }
  /** Manda un texto y devuelve el cuerpo de la última respuesta. */
  const send = async (text: string, phone = OWNER) =>
    textOf(await deliver(structuredClone(fx.textMessage("x", text)), phone));
  /** Toca un botón y devuelve el cuerpo de la última respuesta. */
  async function tap(id: string, title = "x", phone = OWNER) {
    const p = structuredClone(fx.buttonReply) as unknown as {
      entry: { changes: { value: { messages: Record<string, unknown>[] } }[] }[];
    };
    const m = p.entry[0]?.changes[0]?.value.messages[0];
    if (m) {
      m.interactive = { type: "button_reply", button_reply: { id, title } };
      delete m.context;
    }
    return textOf(await deliver(p, phone));
  }
  const last = (phone = OWNER) => sent.filter((s) => s.to === phone).at(-1);
  return { t, tenantId, llm, sent, send, tap, last, deps };
}
