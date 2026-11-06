import { and, eq, isNull, rows, schema, sql, type Tx } from "@caja/db";
import { isLateCodeAsk, lateCode, referralCodeFor } from "../billing/referrals";
import { type GiftLine, type Level, leyendaEnded } from "../billing/rewards";
import { addDays, businessDateOf, lastDayOfMonth } from "../domain/dates";
import { habitSettings } from "../ledger/habits";
import {
  awardCloseDay,
  markNoticeShown,
  nextNotice,
  pointsView,
  syncPoints,
} from "../ledger/points";
import type { Outbound } from "../render/outbound";
import {
  closePointsLine,
  inviteReply,
  lateCodeReply,
  myPoints,
  myPointsEmployee,
  noticeLine,
  pointsHow,
  pointsLevels,
  type WaitingGift,
} from "../render/points-es";

/**
 * «mis puntos», «Cómo sumar» y «Niveles y regalos» en el chat (US-424) y la respuesta a «Eso es
 * todo» (US-426). Rutas fijas, antes del agente y sin LLM (SEC-P4-14 a): ninguna herramienta del
 * agente lee ni escribe puntos. Todo con `habits.xp` encendido; apagado, el chat sigue como hoy.
 */

export type PointsAsk = "view" | "how" | "levels" | "invite";

/** Sin tildes, en minúsculas, sin puntuación y con un solo espacio (como «mis avisos»). */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PHRASES: Record<string, PointsAsk> = {
  "mis puntos": "view",
  puntos: "view",
  "mi nivel": "view",
  "mis logros": "view",
  "como gano puntos": "how",
  "como sumo puntos": "how",
  "como funcionan los puntos": "how",
  "que regalos hay": "levels",
  "que premios hay": "levels",
  // P4-B (§P4.8 «Invite reply»): solo con `referrals`.
  invitar: "invite",
  "mi enlace": "invite",
};

/** El mensaje entero es una de las frases de §P4.8; si no, null (sigue al agente). */
export function classifyPointsAsk(text: string): PointsAsk | null {
  if (text.length > 60) return null;
  return PHRASES[normalize(text)] ?? null;
}

export type PointsChatCtx = {
  tenantId: string;
  role: "owner" | "employee";
  personal: boolean;
  inTrial: boolean;
  dashboardUrl: string;
  now: Date;
};

export type PointsReply = { outbound: Outbound[]; toolCalls: { name: string; args: unknown }[] };

/** La respuesta a una frase o a un botón de puntos; null con `xp` apagado. */
export async function pointsReply(
  tx: Tx,
  ctx: PointsChatCtx,
  ask: PointsAsk,
  via: "text" | "button",
): Promise<PointsReply | null> {
  const flags = await habitSettings(tx);
  if (!flags.xp) return null;
  // Sin `referrals`, «invitar» sigue al agente como hoy.
  if (ask === "invite" && !flags.referrals) return null;
  const mark = { name: "points_view", args: { via, ask } };
  if (ctx.role !== "owner") return { outbound: [myPointsEmployee()], toolCalls: [mark] };
  if (ask === "invite") {
    const invite = await inviteState(tx, ctx.tenantId);
    return { outbound: inviteReply(invite ?? "not_eligible"), toolCalls: [mark] };
  }
  if (ask === "how")
    return {
      outbound: [
        pointsHow({
          business: !ctx.personal,
          flags: {
            dailyClose: flags.dailyClose,
            reminders: flags.reminders,
            referrals: flags.referrals,
          },
        }),
      ],
      toolCalls: [mark],
    };
  if (ask === "levels")
    return {
      outbound: [pointsLevels({ trial: ctx.inTrial, referrals: flags.referrals })],
      toolCalls: [mark],
    };
  await syncPoints(tx, ctx.tenantId, ctx.now, { flags });
  const v = await pointsView(tx, ctx.tenantId, ctx.now);
  const fechaTope = addDays(lastDayOfMonth(businessDateOf(ctx.now)), 1);
  const waiting: WaitingGift[] = v.grants
    .filter((g) => g.status === "waiting" && g.waitReason)
    .map((g) => ({
      level: g.level,
      reason: g.waitReason as WaitingGift["reason"],
      fechaTope,
    }));
  const out = myPoints({
    total: v.total,
    today: v.today,
    level: v.level,
    next: v.next,
    missing: v.missing,
    onlySetup: v.onlySetup,
    trial: ctx.inTrial,
    leyendaEnded: v.level === 5 && (await leyendaEnded(tx, ctx.tenantId)),
    waiting,
    dashboardUrl: ctx.dashboardUrl,
    invite: flags.referrals ? await inviteState(tx, ctx.tenantId) : null,
  });
  return { outbound: [out], toolCalls: [mark] };
}

/**
 * El código para RW4 / RW4-i (P-3): el código si puede invitar, «not_eligible» si todavía no
 * (menos de 3 días con registro), null si su código está pausado (sin línea de invitar).
 */
async function inviteState(
  tx: Tx,
  tenantId: string,
): Promise<{ code: string } | "not_eligible" | null> {
  const [own] = await tx
    .select({ disabledAt: schema.referralCode.disabledAt })
    .from(schema.referralCode)
    .where(eq(schema.referralCode.tenantId, tenantId));
  if (own?.disabledAt) return null;
  const code = await referralCodeFor(tx, tenantId);
  return code ? { code } : "not_eligible";
}

/**
 * «me invitó CODE» después del registro (US-421, RW-late): solo el dueño, con `xp` y `referrals`,
 * sin la IA. null: no es esa frase, o sigue como hoy (empleado, interruptores apagados).
 */
export async function lateCodeRoute(
  tx: Tx,
  ctx: { tenantId: string; role: "owner" | "employee"; now: Date },
  text: string,
): Promise<PointsReply | null> {
  if (ctx.role !== "owner" || !isLateCodeAsk(text)) return null;
  const flags = await habitSettings(tx);
  if (!flags.xp || !flags.referrals) return null;
  const outcome = await lateCode(tx, ctx.tenantId, text, ctx.now);
  return {
    outbound: [lateCodeReply(outcome)],
    toolCalls: [{ name: "referral_late", args: { result: outcome.kind } }],
  };
}

/**
 * «Eso es todo» del dueño (US-426, A44): con `xp` y `dailyClose`, el +2 (solo con el botón de hoy)
 * y RW3-B en texto en lugar del ✅. Un segundo toque, un botón de otro día o `xp` apagado: null (el
 * ✅ de siempre). Una línea de nivel pendiente va dentro de RW3-B y queda vista.
 */
export async function closeDayReply(
  tx: Tx,
  ctx: { tenantId: string; now: Date },
  buttonDate: string,
): Promise<PointsReply | null> {
  const flags = await habitSettings(tx);
  if (!flags.xp || !flags.dailyClose) return null;
  if (!(await awardCloseDay(tx, ctx.tenantId, buttonDate, ctx.now))) return null;
  const st = await syncPoints(tx, ctx.tenantId, ctx.now, { flags });
  if (!st) return null;
  const v = await pointsView(tx, ctx.tenantId, ctx.now);
  // La línea de subir de nivel pendiente (la del más alto), dentro de RW3-B.
  const pending = await nextNotice(tx, ctx.tenantId);
  let levelUp: GiftLine | null = null;
  if (pending?.kind === "level") {
    levelUp = pending.args as unknown as GiftLine;
    await markNoticeShown(tx, pending.id, ctx.now);
  }
  const body = closePointsLine({
    today: st.today,
    total: v.total,
    level: v.level,
    missing: v.missing,
    next: v.next,
    bonus: st.bonusToday,
    levelUp,
  });
  return {
    outbound: [{ type: "text", body }],
    toolCalls: [
      {
        name: "points_line",
        args: { kind: "close", ...(levelUp ? { level: levelUp.level as Level } : {}) },
      },
    ],
  };
}

/**
 * La línea pendiente para la próxima respuesta del dueño (US-425): una por respuesta, la de nivel
 * más alto primero. `commit` la marca vista solo si de verdad salió (si no cabe, espera).
 */
export async function pendingPointsLine(
  tx: Tx,
  tenantId: string,
  contacto: string,
  now: Date,
): Promise<{
  line: string;
  mark: { name: string; args: unknown };
  commit: () => Promise<void>;
} | null> {
  if (!(await habitSettings(tx)).xp) return null;
  for (let i = 0; i < 5; i++) {
    const n = await nextNotice(tx, tenantId);
    if (!n) return null;
    const line = noticeLine(n, contacto);
    // Sin texto (p. ej. Leyenda que llegó después de guardarse): se descarta y se mira la siguiente.
    if (!line) {
      await markNoticeShown(tx, n.id, now);
      continue;
    }
    const level = (n.args as { level?: number }).level;
    return {
      line,
      mark: { name: "points_line", args: { kind: n.kind, ...(level ? { level } : {}) } },
      commit: () => markNoticeShown(tx, n.id, now),
    };
  }
  return null;
}

/**
 * ¿Se tocó algún registro (movimiento, transferencia o cambio) en este turno? `now()` es el inicio
 * de la transacción (lo que pone la base en `created_at`), que puede ser antes de `since`.
 */
export async function recordsTouchedSince(tx: Tx, tenantId: string, since: Date): Promise<boolean> {
  const [r] = rows<{ hit: boolean }>(
    await tx.execute(sql`
    select (
      exists (select 1 from app.movement where tenant_id = ${tenantId}
              and (created_at >= least(now(), ${since}) or deleted_at >= least(now(), ${since})))
      or exists (select 1 from app.account_transfer where tenant_id = ${tenantId}
              and (created_at >= least(now(), ${since}) or deleted_at >= least(now(), ${since})))
      or exists (select 1 from app.exchange_lot where tenant_id = ${tenantId}
              and (created_at >= least(now(), ${since}) or deleted_at >= least(now(), ${since})))
    ) as hit
  `),
  );
  return r?.hit === true;
}

/** Líneas de puntos aún sin mostrar (para /admin y pruebas). */
export async function pendingNoticeCount(tx: Tx, tenantId: string): Promise<number> {
  const found = await tx
    .select({ id: schema.pointsNotice.id })
    .from(schema.pointsNotice)
    .where(and(eq(schema.pointsNotice.tenantId, tenantId), isNull(schema.pointsNotice.shownAt)));
  return found.length;
}
