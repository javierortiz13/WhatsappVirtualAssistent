import { and, type Db, eq, schema, sql, type Tx, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { LlmUnavailableError } from "../agent/llm";
import { deleteLastFlow } from "../agent/tools";
import type { AgentInput, AgentRunner } from "../agent/types";
import { asIsoDate, businessDateOf, formatShortDate } from "../domain/dates";
import { Decimal } from "../domain/money";
import { allowUnknownReply, canUse, type ResolvedSender, resolveSender } from "../identity/resolve";
import {
  amendMovement,
  createExpense,
  createIncomeDayTotal,
  createIncomeSingle,
  DeleteLastDraft,
  dayTotals,
  deleteMovement,
  EditLastDraft,
  ExpenseDraft,
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
import { MetaApiError, type MetaClient } from "../whatsapp/client";
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
  if (
    resolved &&
    resolved.phoneStatus === "pending" &&
    resolved.role === "owner" &&
    resolved.tenantStatus !== "suspended"
  ) {
    return handlePendingOwner(deps, meta, msg, resolved, event.id, log, now);
  }
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

    const route = await routeMessage(tx, deps, msg, {
      tenantId: resolved.tenantId,
      tenantName: tenant.name,
      phoneId: resolved.phoneId,
      role: resolved.role,
      defaultCurrency: (tenant.defaultExpenseCurrency as "USD" | "VES" | null) ?? null,
      vesThreshold: tenant.vesThreshold,
      today,
      inboundId: msg.waMessageId,
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
  tenantId: string;
  tenantName: string;
  phoneId: string;
  role: "owner" | "employee";
  defaultCurrency: "USD" | "VES" | null;
  vesThreshold: string;
  today: ReturnType<typeof businessDateOf>;
  /** wa_message_id del mensaje entrante, para reaccionar sobre él. */
  inboundId: string;
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
      if (keyword === "close") return closeToday(tx, deps, ctx);
      if (keyword === "delete") return deleteLast(tx, deps, ctx, msg);
      if (msg.text.length > deps.config.maxTextLength) return none([es.tooLong()]);
      return runAgent(tx, deps, ctx, msg, { kind: "text", text: msg.text });
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
        // Cancelar se confirma con una reacción sobre el toque del botón: gratis (ADR-014).
        return none([es.cancelled(ctx.inboundId)]);
      }
      if (parsed.kind === "fix") {
        await tx
          .update(schema.pendingAction)
          .set({ payload: sql`${schema.pendingAction.payload} || '{"fixing": true}'::jsonb` })
          .where(eq(schema.pendingAction.id, pending.id));
        return none([es.promptFix()]);
      }
      if (parsed.kind === "choice") {
        if (pending.kind !== "create_income_day_total") return none([es.confirmationExpired()]);
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
    case "currency":
    case "category":
      // Día 5: se reinyectan al agente como respuesta a una aclaración.
      return none([es.outOfScope()]);
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
      sourceChannel: "text",
      dashboardUrl: deps.config.dashboardUrl,
    },
    userText: msg.kind === "text" ? msg.text : "",
    now: (deps.now ?? (() => new Date()))(),
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

async function runAgent(
  tx: Tx,
  deps: ProcessDeps,
  ctx: RouteCtx,
  msg: InboundMessage | null,
  input: AgentInput,
): Promise<RouteResult> {
  const log = deps.log ?? silentLogger;
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
  const [current] = msg
    ? await tx
        .select({ id: schema.message.id })
        .from(schema.message)
        .where(eq(schema.message.waMessageId, msg.waMessageId))
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
        sourceChannel: input.kind === "text" ? "text" : "image",
        dashboardUrl: deps.config.dashboardUrl,
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
      return none([es.expenseSaved(total.usd, total.count)]);
    }
    case "create_income_day_total": {
      const draft = IncomeDayTotalDraft.parse(pending.payload);
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
        es.incomeSaved(totals.salesUsd, totals.expensesUsd, {
          replaced: created.replaced,
          isToday: draft.businessDate === ctx.today,
          dateLabel: formatShortDate(asIsoDate(draft.businessDate)),
        }),
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
        es.incomeSaved(totals.salesUsd, totals.expensesUsd, {
          replaced: 0,
          isToday: draft.businessDate === ctx.today,
          dateLabel: formatShortDate(asIsoDate(draft.businessDate)),
        }),
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
        es.amended(draft.type, await totalsFor(tx, ctx, draft.type, asIsoDate(after.businessDate))),
      ]);
    }
    case "delete_last": {
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
        es.deleted(draft.type, await totalsFor(tx, ctx, draft.type, asIsoDate(gone.businessDate))),
      ]);
    }
    default:
      return none([es.confirmationExpired()]);
  }
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

export type Keyword = "menu" | "rate" | "help" | "close" | "delete" | null;

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
