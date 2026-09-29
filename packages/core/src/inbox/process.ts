import { and, type Db, eq, schema, sql, type Tx, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import type { AgentRunner } from "../agent/types.js";
import { businessDateOf } from "../domain/dates.js";
import { allowUnknownReply, canUse, resolveSender } from "../identity/resolve.js";
import { type Logger, maskPhone, silentLogger } from "../log.js";
import { getRateInfo } from "../rates/current.js";
import { es, type Outbound, parseReplyId } from "../render/index.js";
import { MetaApiError, type MetaClient } from "../whatsapp/client.js";
import type { InboundMessage } from "../whatsapp/types.js";

/**
 * Procesa un job `process-message` (Fase 3, flujo end-to-end). Corre en el worker, ya
 * serializado por teléfono por pg-boss. Reglas:
 * - Idempotente: si el evento ya está `done`, o ya existe una respuesta enviada para él, no repite.
 * - Desconocidos: texto fijo con rate limit, sin LLM, sin guardar contenido.
 * - Botones, menú, tasa y ayuda se resuelven sin LLM. El resto va al agente.
 * - Antes de enviar cada respuesta se registra `message(out, sending)`; si Meta responde con
 *   error se marca `failed` y se reintenta; si no hubo respuesta (red), no se reenvía.
 */
export type ProcessDeps = {
  db: Db;
  metaFor: (phoneNumberId: string) => MetaClient | null;
  agent: AgentRunner;
  log?: Logger;
  now?: () => Date;
  config: {
    assistantName: string;
    dashboardUrl: string;
    supportHint: string | null;
    unknownReplyMax: number;
    unknownReplyWindowMs: number;
    maxEventAgeMs: number;
    maxTextLength: number;
  };
};

export type ProcessOutcome = "done" | "ignored" | "expired" | "duplicate";

export async function processInbound(
  deps: ProcessDeps,
  job: ProcessMessageJob,
): Promise<ProcessOutcome> {
  const log = deps.log ?? silentLogger;
  const now = deps.now ?? (() => new Date());

  const [event] = await deps.db
    .select()
    .from(schema.webhookEvent)
    .where(eq(schema.webhookEvent.id, job.webhookEventId));
  if (!event) {
    log.warn({ webhookEventId: job.webhookEventId }, "evento no encontrado");
    return "ignored";
  }
  if (event.status === "done" || event.status === "ignored" || event.status === "expired")
    return "duplicate";

  const msg = reviveInbound(event.payload);
  const ageMs = now().getTime() - event.receivedAt.getTime();
  if (ageMs > deps.config.maxEventAgeMs) {
    await markEvent(deps.db, event.id, "expired", "evento demasiado viejo para responder");
    log.warn({ waMessageId: msg.waMessageId, ageMs }, "evento vencido");
    return "expired";
  }

  const meta = deps.metaFor(msg.phoneNumberId);
  if (!meta) {
    await markEvent(
      deps.db,
      event.id,
      "failed",
      `número de plataforma desconocido: ${msg.phoneNumberId}`,
    );
    log.error({ phoneNumberId: msg.phoneNumberId }, "sin cliente de Meta para este número");
    return "ignored";
  }
  await deps.db
    .update(schema.webhookEvent)
    .set({ status: "processing" })
    .where(eq(schema.webhookEvent.id, event.id));

  const resolved = await resolveSender(deps.db, msg.sender);
  if (!resolved || !canUse(resolved)) {
    const key = msg.sender.e164 ?? msg.sender.waUserId ?? msg.waMessageId;
    const reply = await allowUnknownReply(deps.db, key, {
      max: deps.config.unknownReplyMax,
      windowMs: deps.config.unknownReplyWindowMs,
      now: now(),
    });
    if (reply && msg.sender.e164) {
      try {
        await meta.sendText(
          msg.sender.e164,
          es.unknownNumber(`${deps.config.dashboardUrl}/registro`).body,
        );
      } catch (err) {
        log.warn(
          { err: errMsg(err), from: maskPhone(msg.sender.e164) },
          "no se pudo responder a desconocido",
        );
      }
    }
    await markEvent(
      deps.db,
      event.id,
      "ignored",
      resolved ? `número ${resolved.phoneStatus}` : "número desconocido",
    );
    log.info(
      { from: maskPhone(msg.sender.e164), replied: reply },
      "mensaje de número no habilitado",
    );
    return "ignored";
  }

  const to = msg.sender.e164 ?? msg.sender.waUserId ?? "";
  const outcome = await withTenant(deps.db, resolved.tenantId, async (tx) => {
    const [tenant] = await tx
      .select()
      .from(schema.tenant)
      .where(eq(schema.tenant.id, resolved.tenantId));
    if (!tenant) throw new Error("tenant no visible en la transacción");

    // Registro del mensaje entrante (idempotente por wa_message_id).
    await tx
      .insert(schema.message)
      .values({
        tenantId: resolved.tenantId,
        phoneId: resolved.phoneId,
        direction: "in",
        waMessageId: msg.waMessageId,
        kind: msg.kind,
        body: msg.kind === "text" ? msg.text : null,
        mediaId: msg.kind === "audio" || msg.kind === "image" ? msg.media.id : null,
        webhookEventId: event.id,
      })
      .onConflictDoNothing({ target: schema.message.waMessageId });

    // ¿Ya respondimos a este evento en un intento anterior?
    const prior = await tx
      .select({ id: schema.message.id, status: schema.message.status })
      .from(schema.message)
      .where(and(eq(schema.message.webhookEventId, event.id), eq(schema.message.direction, "out")));
    if (prior.some((p) => p.status === "ok" || p.status === "sending")) {
      return "duplicate" as const;
    }

    try {
      await meta.markReadWithTyping(msg.waMessageId);
    } catch (err) {
      log.debug({ err: errMsg(err) }, "indicador de escritura falló");
    }

    const started = now();
    const today = businessDateOf(started);
    const route = await routeMessage(tx, deps, msg, {
      tenantId: resolved.tenantId,
      tenantName: tenant.name,
      phoneId: resolved.phoneId,
      role: resolved.role,
      defaultCurrency: (tenant.defaultExpenseCurrency as "USD" | "VES" | null) ?? null,
      today,
    });

    for (const out of route.outbound) {
      const [row] = await tx
        .insert(schema.message)
        .values({
          tenantId: resolved.tenantId,
          phoneId: resolved.phoneId,
          direction: "out",
          kind: out.type,
          body: bodyOf(out),
          status: "sending",
          webhookEventId: event.id,
          toolCalls: route.toolCalls.length ? route.toolCalls : null,
          tokensIn: route.tokensIn || null,
          tokensOut: route.tokensOut || null,
          costUsd: route.costUsd,
          latencyMs: now().getTime() - started.getTime(),
        })
        .returning({ id: schema.message.id });
      if (!row) throw new Error("no se pudo registrar el mensaje saliente");
      try {
        const sent = await sendOutbound(meta, to, out);
        await tx
          .update(schema.message)
          .set({ status: "ok", waMessageId: sent.waMessageId })
          .where(eq(schema.message.id, row.id));
      } catch (err) {
        if (err instanceof MetaApiError) {
          // Meta respondió: sabemos que no se entregó. Marcar failed permite reintentar sin duplicar.
          await tx
            .update(schema.message)
            .set({ status: "failed" })
            .where(eq(schema.message.id, row.id));
          if (!err.retryable) {
            log.warn(
              { status: err.status, code: err.code, to: maskPhone(to) },
              "Meta rechazó el envío",
            );
            continue;
          }
        }
        throw err;
      }
    }
    return "done" as const;
  });

  if (outcome === "duplicate") {
    await markEvent(deps.db, event.id, "done", null);
    log.info({ waMessageId: msg.waMessageId }, "ya respondido; se cierra el job");
    return "duplicate";
  }
  await markEvent(deps.db, event.id, "done", null);
  return "done";
}

type RouteCtx = {
  tenantId: string;
  tenantName: string;
  phoneId: string;
  role: "owner" | "employee";
  defaultCurrency: "USD" | "VES" | null;
  today: ReturnType<typeof businessDateOf>;
};

type RouteResult = {
  outbound: Outbound[];
  toolCalls: { name: string; args: unknown }[];
  tokensIn: number;
  tokensOut: number;
  costUsd: string | null;
};

const none = (outbound: Outbound[]): RouteResult => ({
  outbound,
  toolCalls: [],
  tokensIn: 0,
  tokensOut: 0,
  costUsd: null,
});

async function routeMessage(
  tx: Tx,
  deps: ProcessDeps,
  msg: InboundMessage,
  ctx: RouteCtx,
): Promise<RouteResult> {
  switch (msg.kind) {
    case "interactive":
      return routeInteractive(tx, deps, msg.replyId, ctx);
    case "text": {
      const keyword = classifyKeyword(msg.text);
      if (keyword === "menu") return none([es.menu(await getRateInfo(tx, ctx.today))]);
      if (keyword === "rate") return none([es.rate(await getRateInfo(tx, ctx.today))]);
      if (keyword === "help")
        return none([es.help(deps.config.dashboardUrl, deps.config.supportHint)]);
      if (msg.text.length > deps.config.maxTextLength) return none([es.tooLong()]);
      return runAgent(deps, ctx, msg, { kind: "text", text: msg.text, sourceChannel: "text" });
    }
    case "audio":
      return none([es.mediaNotYet("audio")]);
    case "image":
      return none([es.mediaNotYet("image")]);
    default:
      return none([es.unsupported()]);
  }
}

async function routeInteractive(
  tx: Tx,
  deps: ProcessDeps,
  replyId: string,
  ctx: RouteCtx,
): Promise<RouteResult> {
  const parsed = parseReplyId(replyId);
  switch (parsed.kind) {
    case "menu":
      if (parsed.action === "expense") return none([es.promptExpense()]);
      if (parsed.action === "income") return none([es.promptIncome()]);
      if (ctx.role !== "owner") return none([es.ownerOnly()]);
      return runAgent(deps, ctx, null, {
        kind: "text",
        text: "cierre de hoy",
        sourceChannel: "text",
      });
    case "confirm":
    case "fix":
    case "cancel": {
      // Un id de botón viene del cliente: si no es un UUID, no toca la base.
      if (!UUID_RE.test(parsed.pendingId)) return none([es.confirmationExpired()]);
      const [pending] = await tx
        .select()
        .from(schema.pendingAction)
        .where(
          and(
            eq(schema.pendingAction.id, parsed.pendingId),
            eq(schema.pendingAction.phoneId, ctx.phoneId),
          ),
        );
      const nowTs = (deps.now ?? (() => new Date()))();
      if (pending?.status !== "pending" || pending.expiresAt.getTime() < nowTs.getTime()) {
        return none([es.confirmationExpired()]);
      }
      if (parsed.kind === "cancel") {
        await tx
          .update(schema.pendingAction)
          .set({ status: "cancelled", resolvedAt: nowTs })
          .where(eq(schema.pendingAction.id, pending.id));
        return none([es.cancelled()]);
      }
      if (parsed.kind === "fix") {
        await tx
          .update(schema.pendingAction)
          .set({ payload: sql`${schema.pendingAction.payload} || '{"fixing": true}'::jsonb` })
          .where(eq(schema.pendingAction.id, pending.id));
        return none([es.promptFix()]);
      }
      // confirm: los ejecutores por tipo de acción llegan con el ledger (día 4).
      return none([es.confirmationExpired()]);
    }
    case "currency":
    case "category":
      // Día 5: se reinyectan al agente como respuesta a una aclaración.
      return none([es.outOfScope()]);
    default:
      return none([es.outOfScope()]);
  }
}

async function runAgent(
  deps: ProcessDeps,
  ctx: RouteCtx,
  msg: InboundMessage | null,
  input: Parameters<AgentRunner["run"]>[1],
): Promise<RouteResult> {
  const result = await deps.agent.run({ ...ctx, waMessageId: msg?.waMessageId ?? "" }, input);
  return {
    outbound: result.outbound,
    toolCalls: result.toolCalls,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    costUsd: result.costUsd,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type Keyword = "menu" | "rate" | "help" | null;

export function classifyKeyword(text: string): Keyword {
  const t = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (
    [
      "hola",
      "buenas",
      "buenos dias",
      "buenas tardes",
      "buenas noches",
      "menu",
      "inicio",
      "hey",
      "epale",
    ].includes(t)
  )
    return "menu";
  if (
    [
      "tasa",
      "dolar",
      "bcv",
      "tasa bcv",
      "tasa del dia",
      "tasa de hoy",
      "a como esta el dolar",
      "cuanto esta el dolar",
    ].includes(t)
  )
    return "rate";
  if (["ayuda", "help", "que puedes hacer", "que haces"].includes(t)) return "help";
  return null;
}

export async function sendOutbound(
  meta: MetaClient,
  to: string,
  out: Outbound,
): Promise<{ waMessageId: string }> {
  switch (out.type) {
    case "text":
      return meta.sendText(to, out.body);
    case "buttons":
      return meta.sendButtons(to, out.body, out.buttons, out.footer ? { footer: out.footer } : {});
    case "list":
      return meta.sendList(
        to,
        out.body,
        out.buttonLabel,
        out.sections,
        out.header ? { header: out.header } : {},
      );
  }
}

function bodyOf(out: Outbound): string {
  return out.body;
}

async function markEvent(
  db: Db,
  id: string,
  status: "done" | "ignored" | "expired" | "failed",
  error: string | null,
) {
  await db
    .update(schema.webhookEvent)
    .set({ status, processedAt: new Date(), error })
    .where(eq(schema.webhookEvent.id, id));
}

function reviveInbound(payload: unknown): InboundMessage {
  const p = payload as InboundMessage & { timestamp: string | Date };
  return { ...p, timestamp: new Date(p.timestamp) };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
