import { and, type Db, desc, eq, gt, ne, schema, sql, type Tx, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { z } from "zod";
import { LlmUnavailableError } from "../agent/llm";
import { deleteLastFlow } from "../agent/tools";
import type { AgentInput, AgentRunner, UnclearReceipt } from "../agent/types";
import {
  currentRenewIntent,
  extractReference,
  maybeRenewReference,
  type PaymentDest,
  planFromName,
  RENEW_WORDS,
  type RenewChatCtx,
  renewOfferReply,
  renewPayToReply,
  renewReferenceReply,
} from "../billing/index";
import { asIsoDate, businessDateOf, formatShortDate } from "../domain/dates";
import { Decimal } from "../domain/money";
import {
  allowUnknownReply,
  canUse,
  checkKnownLimit,
  type ResolvedSender,
  resolveSender,
} from "../identity/resolve";
import { createAttachment, discardAttachment } from "../ledger/attachments";
import { budgetStatuses } from "../ledger/budgets";
import {
  amendMovement,
  createExpense,
  createIncomeDayTotal,
  createIncomeSingle,
  DeleteLastDraft,
  DeleteManyDraft,
  dayTotals,
  deleteMovement,
  EditLastDraft,
  ExpenseDraft,
  ExpensesDraft,
  existingDayTotal,
  expenseTotalForDay,
  IncomeDayTotalDraft,
  IncomeSingleDraft,
  PAYMENT_METHOD_LABELS,
  type PaymentMethod,
  renderSummary,
  resolveMismatch,
} from "../ledger/index";
import { type Logger, maskPhone, silentLogger } from "../log";
import { activatePhone, CODE_RE, verifyCode } from "../onboarding/register";
import { getRateInfo } from "../rates/current";
import { es, mergeOutbound, type Outbound, parseReplyId } from "../render/index";
import type { SpeechClient } from "../speech/client";
import type { ObjectStore } from "../storage/store";
import { RECEIPT_MIN_CONFIDENCE, type ReceiptReader } from "../vision/receipt";
import { LIMITS, LimitError, MetaApiError, type MetaClient } from "../whatsapp/client";
import type { InboundMessage } from "../whatsapp/types";

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
  /** Voz a texto (US-B5). Sin cliente, las notas de voz responden "llegan pronto". */
  speech?: SpeechClient | null;
  /** Lectura de facturas (US-B6). Sin lector, las fotos responden "llegan pronto". */
  vision?: ReceiptReader | null;
  /** Bucket privado para las fotos. Sin bucket, la foto se lee pero no se guarda como respaldo. */
  store?: ObjectStore | null;
  log?: Logger;
  now?: () => Date;
  config: {
    assistantName: string;
    dashboardUrl: string;
    supportHint: string | null;
    unknownReplyMax: number;
    unknownReplyWindowMs: number;
    /** Conocidos: mensajes por ventana antes de avisar una vez y callar (checklist S2). */
    knownMax?: number;
    knownWindowMs?: number;
    maxEventAgeMs: number;
    maxTextLength: number;
    /** Datos de cobro por método para renovar el plan por el bot (03/10). */
    paymentDest?: PaymentDest;
  };
};

/** Checklist de seguridad S2: 30 mensajes por 5 minutos para números conocidos. */
export const KNOWN_MAX = 30;
export const KNOWN_WINDOW_MS = 5 * 60 * 1000;

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
  if (
    resolved &&
    resolved.phoneStatus === "pending" &&
    resolved.role === "owner" &&
    resolved.tenantStatus !== "suspended"
  ) {
    return handlePendingOwner(deps, meta, msg, resolved, event.id, log, now);
  }
  // Plan vencido: el dueño sigue pudiendo renovar por el bot; el resto recibe "tu plan venció".
  const suspendedOwner =
    resolved?.phoneStatus === "active" &&
    resolved.tenantStatus === "suspended" &&
    resolved.role === "owner";
  if (!resolved || (!canUse(resolved) && !suspendedOwner)) {
    const key = msg.sender.e164 ?? msg.sender.waUserId ?? msg.waMessageId;
    const reply = await allowUnknownReply(deps.db, key, {
      max: deps.config.unknownReplyMax,
      windowMs: deps.config.unknownReplyWindowMs,
      now: now(),
    });
    // Número activo de un negocio suspendido (plan vencido): no es un desconocido.
    const suspended = resolved?.phoneStatus === "active" && resolved.tenantStatus === "suspended";
    if (reply && msg.sender.e164) {
      try {
        await meta.sendText(
          msg.sender.e164,
          suspended
            ? es.planExpired(deps.config.supportHint).body
            : es.unknownNumber(`${deps.config.dashboardUrl}/registro`).body,
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
      suspended
        ? "negocio suspendido"
        : resolved
          ? `número ${resolved.phoneStatus}`
          : "número desconocido",
    );
    log.info(
      { from: maskPhone(msg.sender.e164), replied: reply },
      "mensaje de número no habilitado",
    );
    return "ignored";
  }

  const to = msg.sender.e164 ?? msg.sender.waUserId ?? "";

  // Rate limit de conocidos: protege la cuota de LLM y de mensajes de servicio (ADR-014) de un
  // teléfono en bucle o robado. Al cruzar el límite un aviso; después, silencio sin tocar el LLM.
  const limit = await checkKnownLimit(deps.db, to, {
    max: deps.config.knownMax ?? KNOWN_MAX,
    windowMs: deps.config.knownWindowMs ?? KNOWN_WINDOW_MS,
    now: now(),
  });
  if (limit !== "ok") {
    if (limit === "notify" && msg.sender.e164) {
      try {
        await meta.sendText(msg.sender.e164, es.tooFast().body);
      } catch (err) {
        log.warn({ err: errMsg(err), from: maskPhone(msg.sender.e164) }, "aviso de límite falló");
      }
    }
    await markEvent(deps.db, event.id, "ignored", "límite de mensajes del remitente");
    log.warn({ from: maskPhone(msg.sender.e164), limit }, "remitente por encima del límite");
    return "ignored";
  }

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
        // El título del botón queda como cuerpo: el historial del agente ve "Dólares" o "Guardar".
        body: msg.kind === "text" ? msg.text : msg.kind === "interactive" ? msg.replyTitle : null,
        mediaId:
          msg.kind === "audio" || msg.kind === "image" || msg.kind === "document"
            ? msg.media.id
            : null,
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

    // Empleado autorizado desde el dashboard: su primer mensaje lo activa y recibe la bienvenida.
    const [phone] = await tx
      .select({ verifiedAt: schema.phoneNumber.verifiedAt, name: schema.phoneNumber.displayName })
      .from(schema.phoneNumber)
      .where(eq(schema.phoneNumber.id, resolved.phoneId));
    const welcome: Outbound[] = [];
    if (phone && !phone.verifiedAt && resolved.role === "employee") {
      await activatePhone(
        tx,
        {
          tenantId: resolved.tenantId,
          phoneId: resolved.phoneId,
          waUserId: msg.sender.waUserId,
          displayName: msg.sender.displayName,
        },
        started,
      );
      welcome.push(es.welcomeEmployee(phone.name ?? msg.sender.displayName, tenant.name));
    }

    const ack = async (out: Outbound) => {
      try {
        const sent = await sendOutbound(meta, to, out);
        await tx.insert(schema.message).values({
          tenantId: resolved.tenantId,
          phoneId: resolved.phoneId,
          direction: "out",
          kind: out.type,
          body: bodyOf(out),
          status: "ok",
          waMessageId: sent.waMessageId,
          webhookEventId: event.id,
        });
      } catch (err) {
        log.debug({ err: errMsg(err) }, "acuse falló");
      }
    };
    const route = await routeMessage(tx, deps, msg, {
      suspended: resolved.tenantStatus === "suspended",
      tenantId: resolved.tenantId,
      tenantName: tenant.name,
      phoneId: resolved.phoneId,
      role: resolved.role,
      defaultCurrency: (tenant.defaultExpenseCurrency as "USD" | "VES" | null) ?? null,
      vesThreshold: tenant.vesThreshold,
      today,
      inboundId: msg.waMessageId,
      ack,
    });

    // Una respuesta = un mensaje (ADR-014): la bienvenida viaja en el mismo envío que la respuesta.
    const first = welcome[0];
    const second = route.outbound[0];
    const outbound =
      first && second
        ? [...mergeOutbound(first, second), ...route.outbound.slice(1)]
        : [...welcome, ...route.outbound];
    for (const out of outbound) {
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
          // 429/5xx: no se entregó; deshacer y reintentar el turno es seguro.
          throw err;
        }
        if (err instanceof LimitError) {
          // No salió (se valida antes de enviar) y reintentar daría lo mismo: se registra y sigue.
          await tx
            .update(schema.message)
            .set({ status: "failed" })
            .where(eq(schema.message.id, row.id));
          log.error(
            { err: err.message, to: maskPhone(to) },
            "mensaje fuera de los límites de Meta",
          );
          continue;
        }
        // Red o tiempo agotado: no se sabe si Meta lo entregó. Deshacer el turno y reintentarlo
        // podía guardar dos veces lo confirmado y mandar dos "✅ Guardado"; se confirma lo hecho.
        await tx
          .update(schema.message)
          .set({ status: "unknown" })
          .where(eq(schema.message.id, row.id));
        log.warn({ err: errMsg(err), to: maskPhone(to) }, "envío sin confirmación de Meta");
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

/**
 * Número del dueño en `pending` (US-A2): solo se acepta el código de 6 dígitos del dashboard. No se
 * guarda el contenido del mensaje ni se usa el LLM. Mismo límite de respuestas que un desconocido.
 */
async function handlePendingOwner(
  deps: ProcessDeps,
  meta: MetaClient,
  msg: InboundMessage,
  resolved: ResolvedSender,
  eventId: string,
  log: Logger,
  now: () => Date,
): Promise<ProcessOutcome> {
  const to = msg.sender.e164;
  const nowTs = now();
  const key = to ?? msg.sender.waUserId ?? msg.waMessageId;
  const allowed = await allowUnknownReply(deps.db, key, {
    max: deps.config.unknownReplyMax,
    windowMs: deps.config.unknownReplyWindowMs,
    now: nowTs,
  });
  const registerUrl = `${deps.config.dashboardUrl}/registro`;
  const outcome = await withTenant(deps.db, resolved.tenantId, async (tx) => {
    const code = msg.kind === "text" ? CODE_RE.exec(msg.text)?.[1] : undefined;
    if (!code) return { reply: es.askCode(registerUrl), note: "pendiente: sin código" };
    const result = await verifyCode(
      tx,
      {
        tenantId: resolved.tenantId,
        phoneId: resolved.phoneId,
        waUserId: msg.sender.waUserId,
        displayName: msg.sender.displayName,
      },
      code,
      nowTs,
    );
    if (result === "mismatch")
      return { reply: es.codeMismatch(), note: "pendiente: código incorrecto" };
    if (result === "expired")
      return { reply: es.codeExpired(registerUrl), note: "pendiente: código vencido" };
    const [tenant] = await tx
      .select({ name: schema.tenant.name })
      .from(schema.tenant)
      .where(eq(schema.tenant.id, resolved.tenantId));
    const rate = await getRateInfo(tx, businessDateOf(nowTs));
    return {
      reply: es.welcomeOwner(tenant?.name ?? "tu negocio", deps.config.assistantName, rate),
      note: null,
    };
  });
  if (to && (allowed || outcome.note === null)) {
    try {
      await sendOutbound(meta, to, outcome.reply);
    } catch (err) {
      log.warn(
        { err: errMsg(err), from: maskPhone(to) },
        "no se pudo responder al número pendiente",
      );
    }
  }
  await markEvent(deps.db, eventId, outcome.note ? "ignored" : "done", outcome.note);
  log.info({ from: maskPhone(to), verified: outcome.note === null }, "mensaje de número pendiente");
  return outcome.note ? "ignored" : "done";
}

type RouteCtx = {
  /** Negocio suspendido: solo se atiende la renovación del plan, sin LLM. */
  suspended: boolean;
  tenantId: string;
  tenantName: string;
  phoneId: string;
  role: "owner" | "employee";
  defaultCurrency: "USD" | "VES" | null;
  vesThreshold: string;
  today: ReturnType<typeof businessDateOf>;
  /** wa_message_id del mensaje entrante, para reaccionar sobre él. */
  inboundId: string;
  /** Envía y registra un acuse antes de terminar la ruta (reacción 🎧 mientras se transcribe). */
  ack: (out: Outbound) => Promise<void>;
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

function renewCtx(deps: ProcessDeps, ctx: RouteCtx): RenewChatCtx {
  return {
    tenantId: ctx.tenantId,
    phoneId: ctx.phoneId,
    now: (deps.now ?? (() => new Date()))(),
    dest: deps.config.paymentDest ?? {},
    supportHint: deps.config.supportHint,
  };
}

/**
 * Negocio suspendido (solo llega el dueño): renovar sí, todo lo demás responde "tu plan venció".
 * Sin LLM: botones de renovación, la referencia del pago y palabras como "renovar" o "pagar".
 */
async function routeSuspended(
  tx: Tx,
  deps: ProcessDeps,
  msg: InboundMessage,
  ctx: RouteCtx,
): Promise<RouteResult> {
  const c = renewCtx(deps, ctx);
  if (msg.kind === "interactive") {
    const parsed = parseReplyId(msg.replyId);
    if (parsed.kind === "renew" || parsed.kind === "renew_ref")
      return routeInteractive(tx, deps, msg.replyId, ctx);
  }
  if (msg.kind === "text") {
    const open = await currentRenewIntent(tx, ctx.phoneId, c.now);
    const reference = extractReference(msg.text, open !== null);
    if (reference) return none([await renewReferenceReply(tx, c, reference)]);
    if (RENEW_WORDS.test(msg.text)) return none([await renewOfferReply(tx, c)]);
  }
  return none([es.planExpired(deps.config.supportHint)]);
}

async function routeMessage(
  tx: Tx,
  deps: ProcessDeps,
  msg: InboundMessage,
  ctx: RouteCtx,
): Promise<RouteResult> {
  if (ctx.suspended) return routeSuspended(tx, deps, msg, ctx);
  switch (msg.kind) {
    case "interactive":
      return routeInteractive(tx, deps, msg.replyId, ctx);
    case "text": {
      // Referencia de un pago del plan con la intención abierta ("ref 123456"): sin LLM.
      if (ctx.role === "owner") {
        const paid = await maybeRenewReference(tx, renewCtx(deps, ctx), msg.text);
        if (paid) return none([paid]);
      }
      const keyword = classifyKeyword(msg.text);
      if (keyword === "menu") return none([es.menu(await getRateInfo(tx, ctx.today))]);
      if (keyword === "rate") return none([es.rate(await getRateInfo(tx, ctx.today))]);
      if (keyword === "help")
        return none([es.help(deps.config.dashboardUrl, deps.config.supportHint)]);
      if (keyword === "dashboard")
        return none([es.dashboardLink(deps.config.dashboardUrl, ctx.role)]);
      if (keyword === "close") return closeToday(tx, deps, ctx);
      if (keyword === "delete") return deleteLast(tx, deps, ctx, msg);
      if (msg.text.length > deps.config.maxTextLength) return none([es.tooLong()]);
      return runAgent(tx, deps, ctx, msg.waMessageId, { kind: "text", text: msg.text });
    }
    case "audio":
      return handleAudio(tx, deps, ctx, msg);
    case "image":
      return handleImage(tx, deps, ctx, msg);
    case "document":
      return handleDocument(tx, deps, ctx, msg);
    default:
      return none([es.unsupported()]);
  }
}

/** Nota de voz: 5 MB y 2 minutos como máximo. */
export const AUDIO_MAX_BYTES = 5 * 1024 * 1024;
export const AUDIO_MAX_SECONDS = 120;

/**
 * Nota de voz (US-B5): acuse con reacción, descarga en memoria, transcripción, y el texto va al
 * agente como si lo hubiera escrito. La transcripción queda como cuerpo del mensaje entrante (el
 * historial la ve); el audio no se guarda en ningún lado.
 */
async function handleAudio(
  tx: Tx,
  deps: ProcessDeps,
  ctx: RouteCtx,
  msg: Extract<InboundMessage, { kind: "audio" }>,
): Promise<RouteResult> {
  const log = deps.log ?? silentLogger;
  const meta = deps.metaFor(msg.phoneNumberId);
  if (!deps.speech || !meta) return none([es.mediaNotYet("audio")]);
  await ctx.ack(es.audioAck(msg.waMessageId));
  let text: string;
  try {
    const info = await meta.getMediaInfo(msg.media.id);
    const media = await meta.downloadMedia(info.url, AUDIO_MAX_BYTES);
    const t = await deps.speech.transcribe(media.bytes, media.mimeType ?? msg.media.mimeType);
    if (t.durationSeconds !== null && t.durationSeconds > AUDIO_MAX_SECONDS)
      return none([es.audioTooLong()]);
    log.info(
      { provider: deps.speech.provider, seconds: t.durationSeconds, confidence: t.confidence },
      "nota de voz transcrita",
    );
    text = t.text;
  } catch (err) {
    if (err instanceof LimitError) return none([es.audioTooLong()]);
    log.warn({ err: errMsg(err) }, "nota de voz: transcripción falló");
    return none([es.audioUnclear()]);
  }
  if (!text) return none([es.audioUnclear()]);
  if (text.length > deps.config.maxTextLength) text = text.slice(0, deps.config.maxTextLength);
  await tx
    .update(schema.message)
    .set({ body: text })
    .where(eq(schema.message.waMessageId, msg.waMessageId));
  const result = await runAgent(tx, deps, ctx, msg.waMessageId, { kind: "voice", text });
  const first = result.outbound[0];
  // Los borradores ya traen "Entendí: …" con la transcripción: no repetirla arriba (y no pasar
  // de los 1024 caracteres que admite un mensaje con botones).
  const showsTranscript = first?.body.includes("Entendí:") ?? false;
  return {
    ...result,
    outbound:
      first && !showsTranscript
        ? [...mergeOutbound(es.transcript(text), first), ...result.outbound.slice(1)]
        : result.outbound,
  };
}

/** Foto o PDF de factura: 5 MB como máximo; JPEG, PNG, WebP o PDF. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const PDF_MIME = "application/pdf";
/** Una factura cabe en pocas páginas; más páginas es otro documento y sube el costo de leerlo. */
export const PDF_MAX_PAGES = 5;

/**
 * Páginas de un PDF sin librería: cuenta los objetos `/Type /Page`. Si las páginas van dentro de
 * flujos comprimidos no se ven y devuelve 0 (desconocido); el tope de 5 MB sigue protegiendo.
 */
export function pdfPageCount(bytes: Uint8Array): number {
  const text = Buffer.from(bytes).toString("latin1");
  return (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

const extOf = (filename: string | null) =>
  filename?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";

/**
 * Documento (US-B6b): un PDF de factura o una foto mandada "como documento" se leen igual que una
 * foto. Cualquier otro archivo (Word, Excel...) se rechaza con un mensaje que dice qué sí se lee.
 */
async function handleDocument(
  tx: Tx,
  deps: ProcessDeps,
  ctx: RouteCtx,
  msg: Extract<InboundMessage, { kind: "document" }>,
): Promise<RouteResult> {
  const mime = (msg.media.mimeType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const ext = extOf(msg.filename);
  const isPdf = mime === PDF_MIME || (!mime && ext === "pdf");
  const isImage = IMAGE_MIMES.has(mime) || (!mime && ["jpg", "jpeg", "png", "webp"].includes(ext));
  if (!isPdf && !isImage) return none([es.documentNotSupported(msg.filename)]);
  return handleImage(tx, deps, ctx, {
    ...msg,
    kind: "image",
    media: { ...msg.media, mimeType: isPdf ? PDF_MIME : msg.media.mimeType },
  });
}

/**
 * Foto de factura (US-B6): acuse 🧾, descarga, lectura con el modelo de visión, foto al bucket
 * como adjunto provisional, y la lectura al agente para que arme el borrador de gasto. Si no es
 * factura o la confianza es baja, pregunta; el adjunto se vincula al confirmar y se borra si se
 * cancela o vence.
 */
async function handleImage(
  tx: Tx,
  deps: ProcessDeps,
  ctx: RouteCtx,
  msg: Extract<InboundMessage, { kind: "image" }>,
): Promise<RouteResult> {
  const log = deps.log ?? silentLogger;
  const meta = deps.metaFor(msg.phoneNumberId);
  if (!deps.vision || !meta) return none([es.mediaNotYet("image")]);
  await ctx.ack(es.imageAck(msg.waMessageId));
  let bytes: Uint8Array;
  let mimeType: string;
  try {
    const info = await meta.getMediaInfo(msg.media.id);
    const media = await meta.downloadMedia(info.url, IMAGE_MAX_BYTES);
    bytes = media.bytes;
    mimeType =
      (media.mimeType ?? msg.media.mimeType ?? "image/jpeg").split(";")[0]?.trim() ?? "image/jpeg";
  } catch (err) {
    if (err instanceof LimitError)
      return none([msg.media.mimeType === PDF_MIME ? es.pdfTooBig() : es.imageTooBig()]);
    log.warn({ err: errMsg(err) }, "foto: descarga falló");
    return none([es.receiptUnclear()]);
  }
  // El tipo lo dice Meta al descargar; un PDF además empieza con "%PDF-".
  if (mimeType === "application/octet-stream" && msg.media.mimeType === PDF_MIME)
    mimeType = PDF_MIME;
  const isPdf = mimeType === PDF_MIME;
  if (isPdf && Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-")
    return none([es.receiptUnclear()]);
  if (!isPdf && !IMAGE_MIMES.has(mimeType)) return none([es.notAReceipt()]);
  if (isPdf) {
    const pages = pdfPageCount(bytes);
    if (pages > PDF_MAX_PAGES) return none([es.pdfTooManyPages(pages, PDF_MAX_PAGES)]);
  }

  let read: Awaited<ReturnType<ReceiptReader["read"]>>;
  try {
    read = await deps.vision.read(bytes, mimeType, { businessName: ctx.tenantName });
  } catch (err) {
    log.warn({ err: errMsg(err) }, "foto: lectura falló");
    return none([es.receiptUnclear()]);
  }
  const e = read.extraction;
  log.info(
    {
      isReceipt: e.is_receipt,
      confidence: e.confidence,
      currency: e.currency,
      costUsd: read.costUsd,
    },
    "factura leída",
  );
  if (!e.is_receipt) return none([es.notAReceipt()]);

  // Respaldo en el bucket (provisional hasta Guardar). Sin bucket, el gasto se registra igual.
  let attachmentId: string | null = null;
  if (deps.store) {
    const ext = isPdf
      ? "pdf"
      : mimeType === "image/png"
        ? "png"
        : mimeType === "image/webp"
          ? "webp"
          : "jpg";
    const key = `${ctx.tenantId}/${ctx.today.slice(0, 7)}/${crypto.randomUUID()}.${ext}`;
    try {
      await deps.store.put(key, bytes, mimeType);
      attachmentId = await createAttachment(tx, {
        tenantId: ctx.tenantId,
        kind: "receipt",
        storageKey: key,
        mimeType,
        sizeBytes: bytes.byteLength,
        sha256: msg.media.sha256,
      });
    } catch (err) {
      log.warn({ err: errMsg(err) }, "foto: no se pudo guardar el respaldo");
    }
  }

  if (e.confidence < RECEIPT_MIN_CONFIDENCE || !e.total) {
    // Una sola pregunta con todo lo que falta; la respuesta siguiente arma el borrador con la
    // foto (ver `unclearReceiptBefore`). El total dudoso se muestra para que lo confirme.
    const unclear: UnclearReceipt = {
      total: e.total || null,
      currency: e.currency,
      vendor: e.vendor || null,
      documentType: e.document_type,
    };
    await tx
      .update(schema.message)
      .set({
        body: `[${isPdf ? "PDF" : "foto"} de factura que no se pudo leer bien]${e.total ? ` posible total ${e.total} ${e.currency}` : ""}${e.vendor ? ` · ${e.vendor}` : ""}`,
      })
      .where(eq(schema.message.waMessageId, msg.waMessageId));
    return {
      ...none([
        es.receiptUnclear({
          keptPhoto: attachmentId !== null,
          guess: e.total ? { total: e.total, currency: e.currency } : null,
        }),
      ]),
      toolCalls: [{ name: UNCLEAR_RECEIPT, args: { ...unclear, attachmentId } }],
      costUsd: read.costUsd,
      tokensIn: read.usage.inputTokens,
      tokensOut: read.usage.outputTokens,
    };
  }

  const summary = `[${isPdf ? "PDF" : "foto"} de factura] ${e.vendor || "proveedor no legible"} · ${e.total} ${e.currency}${e.date ? ` · ${e.date}` : ""}`;
  await tx
    .update(schema.message)
    .set({ body: summary })
    .where(eq(schema.message.waMessageId, msg.waMessageId));
  const result = await runAgent(
    tx,
    deps,
    ctx,
    msg.waMessageId,
    { kind: "receipt", extracted: e, caption: msg.caption },
    attachmentId,
  );
  const first = result.outbound[0];
  return {
    ...result,
    costUsd: sumCost(result.costUsd, read.costUsd),
    tokensIn: result.tokensIn + read.usage.inputTokens,
    tokensOut: result.tokensOut + read.usage.outputTokens,
    outbound: first
      ? [...mergeOutbound(es.receiptRead({ ...e, isPdf }), first), ...result.outbound.slice(1)]
      : result.outbound,
  };
}

function sumCost(a: string | null, b: string | null): string | null {
  if (!a && !b) return null;
  return new Decimal(a ?? 0).plus(b ?? 0).toFixed(6);
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
      return closeToday(tx, deps, ctx);
    case "confirm":
    case "fix":
    case "cancel":
    case "choice": {
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
        // La foto o el PDF provisional de un borrador cancelado se borra (US-B6), sea gasto o venta.
        const payload = pending.payload as {
          attachmentId?: string | null;
          items?: { attachmentId?: string | null }[];
        };
        const atts = [payload.attachmentId, ...(payload.items ?? []).map((i) => i.attachmentId)];
        for (const att of atts)
          if (att)
            await discardAttachment(tx, deps.store ?? null, ctx.tenantId, att, nowTs, deps.log);
        // Cancelar se confirma con una reacción sobre el toque del botón: gratis (ADR-014).
        return none([es.cancelled(ctx.inboundId)]);
      }
      if (parsed.kind === "fix") {
        // Con varios borradores en cola, solo uno queda en corrección: el del botón tocado.
        await tx
          .update(schema.pendingAction)
          .set({ payload: sql`${schema.pendingAction.payload} - 'fixing'` })
          .where(
            and(
              eq(schema.pendingAction.phoneId, ctx.phoneId),
              eq(schema.pendingAction.status, "pending"),
            ),
          );
        await tx
          .update(schema.pendingAction)
          .set({ payload: sql`${schema.pendingAction.payload} || '{"fixing": true}'::jsonb` })
          .where(eq(schema.pendingAction.id, pending.id));
        return none([es.promptFix()]);
      }
      if (parsed.kind === "choice") {
        if (pending.kind !== "create_income_day_total") return none([es.confirmationExpired()]);
        // Reemplazar da de baja la venta del día de todos (también la del dueño): solo el dueño.
        if (parsed.key === "replace" && ctx.role !== "owner") return none([es.replaceOwnerOnly()]);
        const draft = IncomeDayTotalDraft.parse(pending.payload);
        if (parsed.key === "stated" || parsed.key === "breakdown") {
          const resolved = resolveMismatch(draft, parsed.key);
          await tx
            .update(schema.pendingAction)
            .set({ payload: resolved })
            .where(eq(schema.pendingAction.id, pending.id));
          return none([
            es.incomeDayTotalDraft({
              pendingId: pending.id,
              ...resolved,
              today: ctx.today,
              replacedPrevious: false,
              methodLabel: (m) => PAYMENT_METHOD_LABELS[m as PaymentMethod] ?? m,
            }),
          ]);
        }
        // replace / append: ejecutar con el modo elegido.
        return executePending(
          tx,
          { ...pending, payload: { ...draft, mode: parsed.key } },
          ctx,
          nowTs,
        );
      }
      return executePending(tx, pending, ctx, nowTs);
    }
    case "currency": {
      // Respuesta a "¿500 en qué moneda?": vuelve al agente con el historial de los últimos
      // 30 minutos, que contiene el mensaje original y la pregunta.
      const label = parsed.currency === "USD" ? "dólares (USD)" : "bolívares (VES)";
      return runAgent(tx, deps, ctx, ctx.inboundId, {
        kind: "text",
        text: `Respuesta al botón de moneda: ${label}. Registra lo del mensaje anterior en esa moneda.`,
      });
    }
    case "renew": {
      if (ctx.role !== "owner") return none([es.renewOwnerOnly()]);
      const plan = planFromName(parsed.plan);
      if (!plan) return none([await renewOfferReply(tx, renewCtx(deps, ctx))]);
      return none([
        await renewPayToReply(tx, renewCtx(deps, ctx), {
          method: parsed.method,
          plan,
          months: parsed.months,
        }),
      ]);
    }
    case "renew_ref": {
      if (ctx.role !== "owner") return none([es.renewOwnerOnly()]);
      return none([
        await renewReferenceReply(tx, renewCtx(deps, ctx), parsed.reference, parsed.method),
      ]);
    }
    case "category": {
      const [cat] = await tx
        .select({ name: schema.category.name })
        .from(schema.category)
        .where(
          and(
            eq(schema.category.tenantId, ctx.tenantId),
            eq(schema.category.id, parsed.categoryId),
          ),
        );
      if (!cat) return none([es.clarification("No encontré esa categoría. ¿Cuál es?", [])]);
      return runAgent(tx, deps, ctx, ctx.inboundId, {
        kind: "text",
        text: `Respuesta al botón de categoría: ${JSON.stringify(cat.name)}. Aplícala a lo del mensaje anterior.`,
      });
    }
    default:
      return none([es.outOfScope()]);
  }
}

/** "bórralo" sin LLM: borrador de borrado del último movimiento del teléfono. */
async function deleteLast(
  tx: Tx,
  deps: ProcessDeps,
  ctx: RouteCtx,
  msg: InboundMessage,
): Promise<RouteResult> {
  const outcome = await deleteLastFlow({
    tx,
    ctx: {
      tenantId: ctx.tenantId,
      tenantName: ctx.tenantName,
      phoneId: ctx.phoneId,
      role: ctx.role,
      defaultCurrency: ctx.defaultCurrency,
      vesThreshold: ctx.vesThreshold,
      categories: [],
      today: ctx.today,
      sourceMessageDbId: null,
      attachmentId: null,
      sourceChannel: "text",
      dashboardUrl: deps.config.dashboardUrl,
    },
    userText: msg.kind === "text" ? msg.text : "",
    now: (deps.now ?? (() => new Date()))(),
    drafts: { fixing: null, latest: null },
  });
  return outcome.kind === "terminal" ? none(outcome.outbound) : none([es.outOfScope()]);
}

/** "cierre" y el botón Ver cierre: cierre de hoy sin LLM. Solo el dueño. */
async function closeToday(tx: Tx, deps: ProcessDeps, ctx: RouteCtx): Promise<RouteResult> {
  if (ctx.role !== "owner") return none([es.ownerOnly()]);
  return none([
    await renderSummary(tx, {
      tenantId: ctx.tenantId,
      today: ctx.today,
      dashboardUrl: deps.config.dashboardUrl,
      period: "today",
      from: null,
      to: null,
      categoryName: null,
    }),
  ]);
}

/** Marca, en el saliente, de "no pude leer bien la factura": la respuesta siguiente la usa. */
const UNCLEAR_RECEIPT = "receipt_unclear";
const UNCLEAR_WINDOW_MS = 30 * 60_000;

const UnclearMark = z.object({
  name: z.literal(UNCLEAR_RECEIPT),
  args: z.object({
    total: z.string().nullable(),
    currency: z.string().nullable(),
    vendor: z.string().nullable(),
    documentType: z.enum(["expense", "sales", "unknown"]),
    attachmentId: z.string().uuid().nullable(),
  }),
});

/**
 * Si lo último que respondió el bot (en los últimos 30 minutos) fue "no pude leer bien la
 * factura", lo que se leyó y la foto guardada; si no, null. Las reacciones (acuses) no cuentan.
 */
async function unclearReceiptBefore(
  tx: Tx,
  phoneId: string,
  now: Date,
): Promise<{ receipt: UnclearReceipt; attachmentId: string | null } | null> {
  const [last] = await tx
    .select({ toolCalls: schema.message.toolCalls })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.phoneId, phoneId),
        eq(schema.message.direction, "out"),
        ne(schema.message.kind, "reaction"),
        gt(schema.message.createdAt, new Date(now.getTime() - UNCLEAR_WINDOW_MS)),
      ),
    )
    .orderBy(desc(schema.message.createdAt))
    .limit(1);
  const mark = UnclearMark.safeParse(Array.isArray(last?.toolCalls) ? last.toolCalls[0] : null);
  if (!mark.success) return null;
  const { attachmentId, ...receipt } = mark.data.args;
  return { receipt, attachmentId };
}

async function runAgent(
  tx: Tx,
  deps: ProcessDeps,
  ctx: RouteCtx,
  waMessageId: string | null,
  input: AgentInput,
  attachmentId: string | null = null,
): Promise<RouteResult> {
  const log = deps.log ?? silentLogger;
  // Respuesta a una factura ilegible: el agente registra con lo que escribió y hereda la foto.
  if ((input.kind === "text" || input.kind === "voice") && waMessageId && !attachmentId) {
    const prev = await unclearReceiptBefore(tx, ctx.phoneId, (deps.now ?? (() => new Date()))());
    if (prev) {
      input = { ...input, afterUnclearReceipt: prev.receipt };
      attachmentId = prev.attachmentId;
    }
  }
  const categories = await tx
    .select({ id: schema.category.id, name: schema.category.name })
    .from(schema.category)
    .where(
      and(
        eq(schema.category.tenantId, ctx.tenantId),
        eq(schema.category.kind, "expense"),
        eq(schema.category.isActive, true),
      ),
    )
    .orderBy(schema.category.sortOrder);
  const [current] = waMessageId
    ? await tx
        .select({ id: schema.message.id })
        .from(schema.message)
        .where(eq(schema.message.waMessageId, waMessageId))
    : [];
  try {
    const result = await deps.agent.run(
      tx,
      {
        tenantId: ctx.tenantId,
        tenantName: ctx.tenantName,
        phoneId: ctx.phoneId,
        role: ctx.role,
        defaultCurrency: ctx.defaultCurrency,
        vesThreshold: ctx.vesThreshold,
        categories,
        today: ctx.today,
        sourceMessageDbId: current?.id ?? null,
        attachmentId,
        sourceChannel: input.kind === "text" ? "text" : input.kind === "voice" ? "voice" : "image",
        dashboardUrl: deps.config.dashboardUrl,
        billing: { dest: deps.config.paymentDest ?? {}, supportHint: deps.config.supportHint },
      },
      input,
    );
    return {
      outbound: result.outbound,
      toolCalls: result.toolCalls,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: result.costUsd,
    };
  } catch (err) {
    if (err instanceof LlmUnavailableError) {
      log.error({ err: err.message }, "LLM no disponible");
      return none([es.llmDown()]);
    }
    throw err;
  }
}

/**
 * Cómo quedan los presupuestos de las categorías que tocó lo recién guardado, una línea por
 * presupuesto y en la ventana de la fecha de cada gasto. Solo el dueño los ve.
 */
async function budgetLinesFor(
  tx: Tx,
  ctx: RouteCtx,
  items: { categoryId: string | null; businessDate: string }[],
): Promise<string[]> {
  if (ctx.role !== "owner") return [];
  const byDate = new Map<string, Set<string>>();
  for (const i of items) {
    if (!i.categoryId) continue;
    const set = byDate.get(i.businessDate) ?? new Set<string>();
    set.add(i.categoryId);
    byDate.set(i.businessDate, set);
  }
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const [date, ids] of byDate) {
    for (const b of await budgetStatuses(tx, ctx.tenantId, asIsoDate(date), [...ids])) {
      const key = `${b.categoryId}:${b.from}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(es.budgetLine(b, ctx.today));
    }
  }
  return lines;
}

/** Ejecuta un borrador confirmado. Cada tipo de acción escribe en el ledger dentro de la transacción. */
async function executePending(
  tx: Tx,
  pending: typeof schema.pendingAction.$inferSelect,
  ctx: RouteCtx,
  nowTs: Date,
): Promise<RouteResult> {
  switch (pending.kind) {
    case "create_expense": {
      const draft = ExpenseDraft.parse(pending.payload);
      await createExpense(tx, {
        tenantId: ctx.tenantId,
        businessDate: asIsoDate(draft.businessDate),
        amount: new Decimal(draft.amount),
        currency: draft.currency,
        categoryId: draft.categoryId,
        description: draft.description,
        sourceChannel: draft.sourceChannel,
        actor: { phoneId: ctx.phoneId },
        sourceMessageId: draft.sourceMessageId,
        attachmentId: draft.attachmentId,
        rate: {
          id: draft.rateId,
          value: draft.rateValue,
          effectiveDate: asIsoDate(draft.rateEffectiveDate),
          source: draft.rateSource,
        },
      });
      await tx
        .update(schema.pendingAction)
        .set({ status: "confirmed", resolvedAt: nowTs })
        .where(eq(schema.pendingAction.id, pending.id));
      const total = await expenseTotalForDay(tx, ctx.tenantId, asIsoDate(draft.businessDate));
      const budgets = await budgetLinesFor(tx, ctx, [draft]);
      return none([
        ownerView(
          ctx,
          es.expenseSaved(total.usd, total.count, budgets, dayWord(ctx, draft.businessDate)),
          "✅ Guardado.",
        ),
      ]);
    }
    case "create_expenses": {
      const draft = ExpensesDraft.parse(pending.payload);
      for (const item of draft.items) {
        await createExpense(tx, {
          tenantId: ctx.tenantId,
          businessDate: asIsoDate(item.businessDate),
          amount: new Decimal(item.amount),
          currency: item.currency,
          categoryId: item.categoryId,
          description: item.description,
          sourceChannel: item.sourceChannel,
          actor: { phoneId: ctx.phoneId },
          sourceMessageId: item.sourceMessageId,
          attachmentId: item.attachmentId,
          rate: {
            id: item.rateId,
            value: item.rateValue,
            effectiveDate: asIsoDate(item.rateEffectiveDate),
            source: item.rateSource,
          },
        });
      }
      await tx
        .update(schema.pendingAction)
        .set({ status: "confirmed", resolvedAt: nowTs })
        .where(eq(schema.pendingAction.id, pending.id));
      const last = draft.items[draft.items.length - 1];
      const total = await expenseTotalForDay(
        tx,
        ctx.tenantId,
        asIsoDate(last?.businessDate ?? ctx.today),
      );
      const budgets = await budgetLinesFor(tx, ctx, draft.items);
      return none([
        ownerView(
          ctx,
          es.expensesSaved(
            draft.items.length,
            total.usd,
            total.count,
            budgets,
            dayWord(ctx, last?.businessDate ?? ctx.today),
          ),
          `✅ Guardados ${draft.items.length} gastos.`,
        ),
      ]);
    }
    case "create_income_day_total": {
      let draft = IncomeDayTotalDraft.parse(pending.payload);
      // La venta del día se revisa de nuevo al Guardar: otro borrador o el empleado pudieron
      // registrarla después de armar este. Sin esto, Guardar la sumaba dos veces.
      if (!draft.mode && draft.existingUsd === null) {
        const now = await existingDayTotal(tx, ctx.tenantId, asIsoDate(draft.businessDate));
        if (now.count > 0) {
          draft = { ...draft, existingUsd: now.usd.toFixed(2) };
          await tx
            .update(schema.pendingAction)
            .set({ payload: draft })
            .where(eq(schema.pendingAction.id, pending.id));
        }
      }
      // Un desglose sin cuadrar o un día ya cerrado no se guardan con "Guardar": piden decisión.
      if (draft.mismatch || (draft.existingUsd !== null && !draft.mode)) {
        return none([
          es.incomeDayTotalDraft({
            pendingId: pending.id,
            ...draft,
            today: ctx.today,
            replacedPrevious: false,
            methodLabel: (m) => PAYMENT_METHOD_LABELS[m as PaymentMethod] ?? m,
          }),
        ]);
      }
      const created = await createIncomeDayTotal(tx, {
        tenantId: ctx.tenantId,
        businessDate: asIsoDate(draft.businessDate),
        lines: draft.lines.map((l) => ({
          method: l.method,
          amount: new Decimal(l.amount),
          currency: l.currency,
        })),
        replace: draft.mode === "replace",
        actor: { phoneId: ctx.phoneId },
        sourceChannel: draft.sourceChannel,
        sourceMessageId: draft.sourceMessageId,
        attachmentId: draft.attachmentId,
        rate: {
          id: draft.rateId,
          value: draft.rateValue,
          effectiveDate: asIsoDate(draft.rateEffectiveDate),
          source: draft.rateSource,
        },
      });
      await tx
        .update(schema.pendingAction)
        .set({ status: "confirmed", resolvedAt: nowTs })
        .where(eq(schema.pendingAction.id, pending.id));
      const totals = await dayTotals(tx, ctx.tenantId, asIsoDate(draft.businessDate));
      return none([
        ownerView(
          ctx,
          es.incomeSaved(totals.salesUsd, totals.expensesUsd, {
            replaced: created.replaced,
            isToday: draft.businessDate === ctx.today,
            dateLabel: formatShortDate(asIsoDate(draft.businessDate)),
          }),
          "✅ Venta guardada.",
        ),
      ]);
    }
    case "create_income_single": {
      const draft = IncomeSingleDraft.parse(pending.payload);
      await createIncomeSingle(tx, {
        tenantId: ctx.tenantId,
        businessDate: asIsoDate(draft.businessDate),
        line: { method: draft.method, amount: new Decimal(draft.amount), currency: draft.currency },
        description: draft.description,
        actor: { phoneId: ctx.phoneId },
        sourceChannel: draft.sourceChannel,
        sourceMessageId: draft.sourceMessageId,
        attachmentId: draft.attachmentId,
        rate: {
          id: draft.rateId,
          value: draft.rateValue,
          effectiveDate: asIsoDate(draft.rateEffectiveDate),
          source: draft.rateSource,
        },
      });
      await tx
        .update(schema.pendingAction)
        .set({ status: "confirmed", resolvedAt: nowTs })
        .where(eq(schema.pendingAction.id, pending.id));
      const totals = await dayTotals(tx, ctx.tenantId, asIsoDate(draft.businessDate));
      return none([
        ownerView(
          ctx,
          es.incomeSaved(totals.salesUsd, totals.expensesUsd, {
            replaced: 0,
            isToday: draft.businessDate === ctx.today,
            dateLabel: formatShortDate(asIsoDate(draft.businessDate)),
          }),
          "✅ Venta guardada.",
        ),
      ]);
    }
    case "edit_last": {
      const draft = EditLastDraft.parse(pending.payload);
      const after = await amendMovement(tx, {
        tenantId: ctx.tenantId,
        draft,
        actor: { phoneId: ctx.phoneId },
        now: nowTs,
      });
      await tx
        .update(schema.pendingAction)
        .set({ status: "confirmed", resolvedAt: nowTs })
        .where(eq(schema.pendingAction.id, pending.id));
      if (!after) return none([es.alreadyGone()]);
      return none([
        ownerView(
          ctx,
          es.amended(
            draft.type,
            await totalsFor(tx, ctx, draft.type, asIsoDate(after.businessDate)),
          ),
          "✅ Corregido.",
        ),
      ]);
    }
    case "delete_last": {
      const many = DeleteManyDraft.safeParse(pending.payload);
      if (many.success) {
        const items = many.data.items;
        let removed = 0;
        let lastGone: { businessDate: string } | null = null;
        for (const item of items) {
          const gone = await deleteMovement(tx, {
            tenantId: ctx.tenantId,
            movementId: item.movementId,
            actor: { phoneId: ctx.phoneId },
            now: nowTs,
          });
          if (gone) {
            removed += 1;
            lastGone = gone;
          }
        }
        await tx
          .update(schema.pendingAction)
          .set({ status: "confirmed", resolvedAt: nowTs })
          .where(eq(schema.pendingAction.id, pending.id));
        if (!removed || !lastGone) return none([es.alreadyGone()]);
        const type = items.every((i) => i.type === items[0]?.type)
          ? (items[0]?.type ?? null)
          : null;
        const sameDay = items.every(
          (i) => i.snapshot.businessDate === items[0]?.snapshot.businessDate,
        );
        const totals =
          type && sameDay ? await totalsFor(tx, ctx, type, asIsoDate(lastGone.businessDate)) : null;
        return none([
          es.deletedMany(removed, items.length, type, ctx.role === "owner" ? totals : null),
        ]);
      }
      const draft = DeleteLastDraft.parse(pending.payload);
      const gone = await deleteMovement(tx, {
        tenantId: ctx.tenantId,
        movementId: draft.movementId,
        actor: { phoneId: ctx.phoneId },
        now: nowTs,
      });
      await tx
        .update(schema.pendingAction)
        .set({ status: "confirmed", resolvedAt: nowTs })
        .where(eq(schema.pendingAction.id, pending.id));
      if (!gone) return none([es.alreadyGone()]);
      return none([
        ownerView(
          ctx,
          es.deleted(
            draft.type,
            await totalsFor(tx, ctx, draft.type, asIsoDate(gone.businessDate)),
          ),
          "✅ Eliminado.",
        ),
      ]);
    }
    default:
      return none([es.confirmationExpired()]);
  }
}

/**
 * Los totales del día son del dueño (DISENO-MVP: el empleado registra, no ve cierres). Al
 * empleado se le confirma sin cifras del negocio.
 */
function ownerView(ctx: RouteCtx, out: Outbound, employeeText: string): Outbound {
  return ctx.role === "owner" ? out : { type: "text", body: employeeText };
}

/** "hoy" o "del lun 29/09": el total que acompaña al guardado es el del día del gasto. */
function dayWord(ctx: RouteCtx, date: string): string {
  return date === ctx.today ? "hoy" : `del ${formatShortDate(asIsoDate(date))}`;
}

async function totalsFor(
  tx: Tx,
  ctx: RouteCtx,
  type: "expense" | "income",
  date: ReturnType<typeof asIsoDate>,
): Promise<{ usd: Decimal; count: number }> {
  if (type === "expense") return expenseTotalForDay(tx, ctx.tenantId, date);
  const t = await dayTotals(tx, ctx.tenantId, date);
  return { usd: t.salesUsd, count: t.count };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type Keyword = "menu" | "rate" | "help" | "close" | "delete" | "dashboard" | null;

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
  if (["cierre", "cierre de hoy", "cierre del dia", "como fue hoy", "como vamos hoy"].includes(t))
    return "close";
  if (
    [
      "borralo",
      "borrala",
      "eliminalo",
      "eliminala",
      "borra eso",
      "elimina eso",
      "borra el ultimo",
      "elimina el ultimo",
      "quita el ultimo",
      "quitalo",
    ].includes(t)
  )
    return "delete";
  // "link del dashboard", "pásame el enlace", "cuál es la página": mensaje corto, sin cifras y sin
  // hablar de pagos ("el link de pago" es de la renovación).
  if (
    DASHBOARD_WORDS.test(t) &&
    !/\d/.test(t) &&
    !/\b(pago|pagar|pague|renovar|renuevo)\b/.test(t) &&
    t.split(" ").length <= 8
  )
    return "dashboard";
  return null;
}

const DASHBOARD_WORDS = /\b(dashboard|dashbord|dasboard|panel|link|enlace|pagina|web)\b/;

/** Cuerpo dentro del límite de Meta para botones y listas (1024): se recorta en vez de fallar. */
function clip(body: string, max: number): string {
  return body.length <= max ? body : `${body.slice(0, max - 1)}…`;
}

export async function sendOutbound(
  meta: MetaClient,
  to: string,
  original: Outbound,
): Promise<{ waMessageId: string }> {
  const out =
    original.type === "buttons" || original.type === "list"
      ? { ...original, body: clip(original.body, LIMITS.interactiveBody) }
      : original.type === "text"
        ? { ...original, body: clip(original.body, LIMITS.textBody) }
        : original;
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
    case "reaction":
      return meta.sendReaction(to, out.waMessageId, out.body);
  }
}

function bodyOf(out: Outbound): string {
  return out.body;
}

/** Estado final de un evento del webhook. El worker lo usa cuando un job agota los reintentos. */
export async function markWebhookEvent(
  db: Db,
  id: string,
  status: "done" | "ignored" | "expired" | "failed",
  error: string | null,
): Promise<void> {
  return markEvent(db, id, status, error);
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
