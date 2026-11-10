"use server";

import {
  addExtraMessages,
  approvePayment,
  approveRefMonth,
  BatchRefused,
  cancelSignupBatch,
  Decimal,
  type FlagChangeError,
  type FlagState,
  founderDiscount,
  founderUntilFrom,
  habitSettings,
  latestRates,
  PLANS,
  paidAmountUsd,
  parseCeiling,
  parseVenezuelanAmount,
  planById,
  quote,
  RECHARGE,
  REMOVE_REASONS,
  ReviewRefused,
  recordPayment,
  refuseRefMonth,
  rejectPayment,
  removePoints,
  rewardChangesForFlags,
  rewardSettings,
  saveHabitSettings,
  saveLaunchSettings,
  saveRewardSettings,
  saveSignupRescueSettings,
  scheduleSignupBatch,
  setTenantBilling,
  signupRescueSettings,
  subscriptionState,
  syncInvitee,
  TRIAL_DAYS,
  validateFlagSave,
  withDiscount,
} from "@caja/core";
import { businessDateOf } from "@caja/core/domain";
import { errorText } from "@caja/core/log";
import { and, eq, isNotNull, isNull, schema, withTenant } from "@caja/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { db } from "@/lib/db";
import { confirmsName, eraseBusiness, restoreBusiness, trashBusiness } from "@/lib/erase";

const DAY = 24 * 60 * 60 * 1000;
const PlanId = z.enum(PLANS.map((p) => p.id) as ["personal", "negocio", "negocio_plus"]);
/** Pestaña de la ficha del negocio a la que vuelve cada acción (rediseño 08/11). */
type TenantTab = "resumen" | "pagos" | "numeros" | "puntos" | "acciones" | "historial";
const back = (tenantId: string, q: string, tab: TenantTab = "resumen") =>
  redirect(`/admin/negocios/${tenantId}?tab=${tab}&${q}`);

function fail(tenantId: string, code: string, err?: unknown, tab: TenantTab = "resumen"): never {
  if (err)
    console.error(JSON.stringify({ level: "error", msg: `admin ${code}`, detail: errorText(err) }));
  return back(tenantId, `error=${code}`, tab);
}

/** Error de un interruptor → el código de la URL (los textos están en `messages.ts`). */
const FLAG_ERROR: Record<FlagChangeError, string> = {
  sticky: "avisos_fijo",
  blocked: "bloqueado",
  managed: "del_lote",
  needs: "depende",
  approval_pending: "aprobacion_pendiente",
  approval_code: "aprobacion",
};

/** Todos los interruptores de /admin como los ve hoy la base. */
async function currentFlags(): Promise<FlagState> {
  const [h, r] = await Promise.all([habitSettings(db()), signupRescueSettings(db())]);
  return {
    streakLine: h.streakLine,
    noSpend: h.noSpend,
    prefs: h.prefs,
    nudge: h.nudge,
    dailyClose: h.dailyClose,
    reminders: h.reminders,
    xp: h.xp,
    rewards: h.rewards,
    referrals: h.referrals,
    inWindow: r.inWindow,
    template: r.template,
    viaTemplate: r.inWindowVia === "template",
  };
}

/** Código de aprobación que escribió el administrador en la hoja (o nada). */
const approvalCode = (formData: FormData) => String(formData.get("approval_code") ?? "").trim();

const PaymentForm = z.object({
  tenant_id: z.string().uuid(),
  plan: PlanId,
  method: z.enum(["pago_movil", "zelle", "binance"]),
  months: z.coerce.number().int().min(1).max(12),
  amount: z.string().trim().min(1),
  reference: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(300).optional(),
  approve: z.literal("on").optional(),
});

/** Registra un pago que el cliente reportó; marcado "aprobar", activa el plan de una vez. */
export async function recordPaymentAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = PaymentForm.safeParse(Object.fromEntries(formData));
  const tenantId = String(formData.get("tenant_id") ?? "");
  if (!parsed.success) fail(tenantId, "datos", undefined, "pagos");
  const f = parsed.data;
  // "19.99", "19,99", "19.527,03" y "19527.03" se leen bien; "1.200" son mil doscientos.
  const amount = parseVenezuelanAmount(f.amount);
  if (!amount || amount.lte(0)) fail(tenantId, "monto", undefined, "pagos");
  const plan = planById(f.plan);
  const q = quote(plan, f.method, f.months, await latestRates(db()));
  const now = new Date();
  try {
    await withTenant(db(), f.tenant_id, async (tx) => {
      const currency = f.method === "pago_movil" ? "VES" : f.method === "zelle" ? "USD" : "USDT";
      const [t] = await tx
        .select({ founderUntil: schema.tenant.founderUntil })
        .from(schema.tenant)
        .where(eq(schema.tenant.id, f.tenant_id));
      // Lo que de verdad se cobró (con el 40 % de fundador, p. ej.), no el precio de lista.
      const listed = withDiscount(
        new Decimal(plan.priceUsd).mul(f.months),
        founderDiscount({ founderUntil: t?.founderUntil ?? null }, now),
      );
      const rateValue = q?.rateValue ? new Decimal(q.rateValue) : null;
      return recordPayment(
        tx,
        {
          tenantId: f.tenant_id,
          plan: plan.id,
          months: f.months,
          method: f.method,
          amount,
          currency,
          rateKind: q?.rateKind ?? null,
          rateValue: q?.rateValue ?? null,
          amountUsd: paidAmountUsd(amount, currency, rateValue, listed),
          reference: f.reference || null,
          notes: f.notes || null,
        },
        admin,
        now,
        { approve: f.approve === "on" },
      );
    });
  } catch (err) {
    fail(f.tenant_id, "servidor", err, "pagos");
  }
  revalidatePath("/admin");
  back(f.tenant_id, f.approve === "on" ? "ok=pago_aprobado" : "ok=pago_registrado", "pagos");
}

const PaymentRef = z.object({
  tenant_id: z.string().uuid(),
  payment_id: z.string().uuid(),
  reason: z.string().trim().max(300).optional(),
  from: z.enum(["panel", "negocio"]).optional(),
});

export async function approvePaymentAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = PaymentRef.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/admin/pagos?error=datos");
  const f = parsed.data;
  try {
    await withTenant(db(), f.tenant_id, (tx) =>
      approvePayment(tx, f.tenant_id, f.payment_id, admin, new Date()),
    );
  } catch (err) {
    fail(f.tenant_id, "servidor", err, "pagos");
  }
  revalidatePath("/admin");
  if (f.from === "panel") redirect("/admin/pagos?ok=pago_aprobado");
  back(f.tenant_id, "ok=pago_aprobado", "pagos");
}

export async function rejectPaymentAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = PaymentRef.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/admin/pagos?error=datos");
  const f = parsed.data;
  try {
    await withTenant(db(), f.tenant_id, (tx) =>
      rejectPayment(tx, f.tenant_id, f.payment_id, admin, f.reason || null, new Date()),
    );
  } catch (err) {
    fail(f.tenant_id, "servidor", err, "pagos");
  }
  revalidatePath("/admin");
  if (f.from === "panel") redirect("/admin/pagos?ok=pago_rechazado");
  back(f.tenant_id, "ok=pago_rechazado", "pagos");
}

const TenantChange = z.object({
  tenant_id: z.string().uuid(),
  op: z.enum(["plan", "extend", "suspend", "reactivate", "trial_budget"]),
  plan: PlanId.optional(),
  days: z.coerce.number().int().min(1).max(366).optional(),
  /** Tope de gasto de la prueba en USD ("4" o "4,50"); vacío = el del plan. */
  budget: z
    .string()
    .trim()
    .regex(/^(\d{1,3}([.,]\d{1,2})?)?$/)
    .optional(),
});

/**
 * Cambios sin pago: cambiar plan, extender (cortesía o prueba más larga), tope de gasto de la
 * prueba, suspender a mano o reactivar. Reactivar solo si queda vigencia; si no, primero se extiende o se registra un pago.
 */
export async function changeTenantAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = TenantChange.safeParse(Object.fromEntries(formData));
  const tenantId = String(formData.get("tenant_id") ?? "");
  if (!parsed.success) fail(tenantId, "datos", undefined, "acciones");
  const f = parsed.data;
  const now = new Date();
  let outcome = "ok=guardado";
  try {
    await withTenant(db(), f.tenant_id, async (tx) => {
      const [t] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, f.tenant_id));
      if (!t) throw new Error("negocio no encontrado");
      if (f.op === "plan") {
        if (!f.plan) throw new Error("falta el plan");
        await setTenantBilling(tx, t, { plan: f.plan }, admin, now, "change_plan");
      } else if (f.op === "extend") {
        const days = f.days ?? 7;
        const paid = t.paidUntil !== null || t.status === "active";
        const from = Math.max(now.getTime(), (paid ? t.paidUntil : t.trialEndsAt)?.getTime() ?? 0);
        const until = new Date(from + days * DAY);
        await setTenantBilling(
          tx,
          t,
          paid ? { status: "active", paidUntil: until } : { status: "trial", trialEndsAt: until },
          admin,
          now,
          "extend",
        );
      } else if (f.op === "trial_budget") {
        const budget = f.budget ? Number(f.budget.replace(",", ".")).toFixed(2) : null;
        // Con un tope nuevo, si lo vuelve a alcanzar se avisa otra vez.
        await setTenantBilling(
          tx,
          t,
          { trialBudgetUsd: budget, trialCapNotifiedAt: null },
          admin,
          now,
          "trial_budget",
        );
      } else if (f.op === "suspend") {
        await setTenantBilling(tx, t, { status: "suspended" }, admin, now, "suspend");
      } else {
        const back = t.paidUntil ? "active" : "trial";
        const state = subscriptionState({ ...t, status: back }, now);
        if (state.kind === "expired") {
          outcome = "error=sin_vigencia";
          return;
        }
        await setTenantBilling(tx, t, { status: back }, admin, now, "reactivate");
      }
    });
  } catch (err) {
    fail(f.tenant_id, "servidor", err, "acciones");
  }
  revalidatePath("/admin");
  back(f.tenant_id, outcome, "acciones");
}

/**
 * Eliminar un negocio (0017), escribiendo su nombre para confirmar: `trash` lo pone 15 días en la
 * papelera; `now` lo borra ya para siempre (cuentas de prueba). No se puede deshacer.
 */
export async function eraseTenantAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const tenantId = String(formData.get("tenant_id") ?? "");
  const mode = formData.get("mode") === "now" ? "now" : "trash";
  if (!z.string().uuid().safeParse(tenantId).success) redirect("/admin/clientes?error=datos");
  const name = await withTenant(db(), tenantId, async (tx) => {
    const [t] = await tx
      .select({ name: schema.tenant.name })
      .from(schema.tenant)
      .where(eq(schema.tenant.id, tenantId));
    return t?.name ?? null;
  });
  if (name === null) redirect("/admin/clientes?error=datos");
  if (!confirmsName(formData.get("confirm"), name)) back(tenantId, "error=confirmar", "acciones");
  try {
    if (mode === "now") await eraseBusiness(tenantId);
    else await trashBusiness(tenantId, "admin", { type: "user", id: admin.userId }, "admin");
  } catch (err) {
    fail(tenantId, "servidor", err, "acciones");
  }
  revalidatePath("/admin");
  if (mode === "now") redirect("/admin/clientes?ok=eliminado");
  back(tenantId, "ok=papelera", "acciones");
}

/** Saca un negocio de la papelera (0017). */
export async function restoreTenantAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const tenantId = String(formData.get("tenant_id") ?? "");
  if (!z.string().uuid().safeParse(tenantId).success) redirect("/admin/clientes?error=datos");
  try {
    await restoreBusiness(tenantId, { type: "user", id: admin.userId }, "admin");
  } catch (err) {
    fail(tenantId, "servidor", err, "acciones");
  }
  revalidatePath("/admin");
  back(tenantId, "ok=recuperado", "acciones");
}

// ---------------------------------------------------------------- CRM (0019)

const CrmForm = z.object({
  tenant_id: z.string().uuid(),
  notes: z.string().max(4000).optional(),
  tags: z.string().max(300).optional(),
});

/** Notas y etiquetas internas del negocio ("amigo, fundador, autolavado"). */
export async function saveCrmAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const tenantId = String(formData.get("tenant_id") ?? "");
  const parsed = CrmForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) fail(tenantId, "datos");
  const tags = [
    ...new Set(
      (parsed.data.tags ?? "")
        .split(",")
        .map((x) => x.trim().toLowerCase())
        .filter((x) => x.length > 0 && x.length <= 30),
    ),
  ].slice(0, 12);
  try {
    await withTenant(db(), tenantId, (tx) =>
      tx
        .update(schema.tenant)
        .set({ crmNotes: parsed.data.notes?.trim() || null, crmTags: tags })
        .where(eq(schema.tenant.id, tenantId)),
    );
  } catch (err) {
    fail(tenantId, "servidor", err);
  }
  revalidatePath("/admin");
  back(tenantId, "ok=guardado");
}

/** Da o quita el precio fundador (40 % por 7 meses desde hoy). */
export async function setFounderAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const tenantId = String(formData.get("tenant_id") ?? "");
  if (!z.string().uuid().safeParse(tenantId).success) redirect("/admin/clientes?error=datos");
  const on = formData.get("founder") === "on";
  const now = new Date();
  try {
    await withTenant(db(), tenantId, async (tx) => {
      const [t] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId));
      if (!t) throw new Error("negocio no encontrado");
      const founderUntil = on ? founderUntilFrom(businessDateOf(now)) : null;
      await tx.update(schema.tenant).set({ founderUntil }).where(eq(schema.tenant.id, tenantId));
      await tx.insert(schema.auditLog).values({
        tenantId,
        actorType: "user",
        actorId: admin.userId,
        action: on ? "founder_on" : "founder_off",
        entity: "tenant",
        entityId: tenantId,
        before: { founderUntil: t.founderUntil },
        after: { founderUntil },
        channel: "admin",
      });
    });
  } catch (err) {
    fail(tenantId, "servidor", err);
  }
  revalidatePath("/admin");
  back(tenantId, "ok=guardado");
}

/** Regala una recarga (+100 mensajes este mes), por ejemplo a un amigo que se quedó corto. */
export async function giftRechargeAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const tenantId = String(formData.get("tenant_id") ?? "");
  if (!z.string().uuid().safeParse(tenantId).success) redirect("/admin/clientes?error=datos");
  try {
    await withTenant(db(), tenantId, async (tx) => {
      const [t] = await tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId));
      if (!t) throw new Error("negocio no encontrado");
      await addExtraMessages(tx, t, RECHARGE.messages, admin, new Date(), "admin_gift");
    });
  } catch (err) {
    fail(tenantId, "servidor", err);
  }
  revalidatePath("/admin");
  back(tenantId, "ok=recarga");
}

const LaunchForm = z.object({
  mode: z.enum(["beta", "live"]),
  survey_day: z.coerce
    .number()
    .int()
    .min(1)
    .max(TRIAL_DAYS - 1),
  value_day: z.coerce
    .number()
    .int()
    .min(1)
    .max(TRIAL_DAYS - 1),
});

/** Modo beta/live (0021) y días de la encuesta y del resumen de la prueba. */
export async function saveLaunchAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = LaunchForm.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/admin/cobro?error=datos");
  try {
    await saveLaunchSettings(
      db(),
      {
        beta: parsed.data.mode === "beta",
        surveyDay: parsed.data.survey_day,
        valueDay: parsed.data.value_day,
      },
      admin.email,
      new Date(),
    );
  } catch (err) {
    console.error(
      JSON.stringify({ level: "error", msg: "admin lanzamiento", detail: errorText(err) }),
    );
    redirect("/admin/cobro?error=servidor");
  }
  revalidatePath("/", "layout");
  redirect("/admin/cobro?ok=lanzamiento");
}

/**
 * Interruptores del hábito (PRD hábitos, fase 1). Se encienden solo después de su aprobación;
 * apagarlos es el freno de emergencia (una racha mal calculada se apaga el mismo día).
 */
export async function saveHabitsAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const prefs = formData.get("prefs") === "on";
  const reminders = formData.get("reminders") === "on";
  const nudge = formData.get("nudge") === "on";
  const dailyClose = formData.get("daily_close") === "on";
  const streakLine = formData.get("streak_line") === "on";
  const noSpend = formData.get("no_spend") === "on";
  // Avisos va primero (PRD hábitos §6) y no se apaga; el mensaje para todos va con el aviso de
  // las 8 pm; encender uno con aprobación pide su código exacto (rediseño 08/11, `admin/flags`).
  const flagsBefore = await currentFlags();
  const check = validateFlagSave(
    flagsBefore,
    { ...flagsBefore, streakLine, noSpend, prefs, nudge, dailyClose, reminders },
    approvalCode(formData),
  );
  if (!check.ok) redirect(`/admin/interruptores?error=${FLAG_ERROR[check.error]}`);
  try {
    // P4 (P-16): el día en que cambia `dailyClose` mueve la fecha de /puntos.
    const now = new Date();
    const before = await habitSettings(db());
    if (before.dailyClose !== dailyClose)
      await saveRewardSettings(
        db(),
        rewardChangesForFlags(before, { ...before, dailyClose }, await rewardSettings(db()), now),
        admin.email,
        now,
      );
    await saveHabitSettings(
      db(),
      { streakLine, noSpend, prefs, reminders, nudge, dailyClose },
      admin.email,
      new Date(),
      { approval: check.approval },
    );
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "admin hábito", detail: errorText(err) }));
    redirect("/admin/interruptores?error=servidor");
  }
  revalidatePath("/", "layout");
  redirect("/admin/interruptores?ok=habito");
}

/**
 * Puntos, regalos e invitaciones (PRD hábitos v4.2.1 US-413, SEC-P4-3, SEC-P4-11): `requireAdmin`
 * dentro de la acción; `rewards` o `referrals` sin `xp` se rechazan; el tope va de 0 a 200 con dos
 * decimales. Encender `xp` guarda el día
 * (A40). `audit_log` exige un negocio: el antes y el después quedan en el log del servidor y
 * `app_setting.updated_by` guarda el correo.
 */
export async function saveRewardsAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const xp = formData.get("xp") === "on";
  const rewards = formData.get("rewards") === "on";
  const referrals = formData.get("referrals") === "on";
  // Vuelve a donde estaba: el tope se cambia en «Puntos», los interruptores en «Interruptores».
  const page = formData.get("from") === "puntos" ? "/admin/puntos" : "/admin/interruptores";
  const flagsBefore = await currentFlags();
  const check = validateFlagSave(
    flagsBefore,
    { ...flagsBefore, xp, rewards, referrals },
    approvalCode(formData),
  );
  if (!check.ok) redirect(`${page}?error=${FLAG_ERROR[check.error]}`);
  const ceiling = parseCeiling(formData.get("ceiling"));
  if (ceiling === null) redirect(`${page}?error=tope`);
  const now = new Date();
  try {
    const before = await habitSettings(db());
    const rs = await rewardSettings(db());
    const after = { ...before, xp, rewards, referrals };
    await saveHabitSettings(db(), { xp, rewards, referrals }, admin.email, now, {
      approval: check.approval,
    });
    await saveRewardSettings(
      db(),
      { monthlyCeilingUsd: ceiling, ...rewardChangesForFlags(before, after, rs, now) },
      admin.email,
      now,
    );
    console.info(
      JSON.stringify({
        level: "info",
        msg: "admin: puntos y regalos",
        admin: admin.email,
        before: {
          xp: before.xp,
          rewards: before.rewards,
          referrals: before.referrals,
          ceiling: rs.monthlyCeilingUsd,
        },
        after: { xp, rewards, referrals, ceiling },
        approval: check.approval,
      }),
    );
  } catch (err) {
    console.error(JSON.stringify({ level: "error", msg: "admin puntos", detail: errorText(err) }));
    redirect(`${page}?error=servidor`);
  }
  revalidatePath("/", "layout");
  revalidatePath("/puntos");
  redirect(`${page}?ok=puntos`);
}

/** Quita la línea roja del tope (A46) hasta la próxima vez que pase dos meses seguidos. */
export async function dismissRewardsAlertAction(): Promise<void> {
  const admin = await requireAdmin();
  await saveRewardSettings(db(), { alertDismissed: true }, admin.email, new Date());
  console.info(
    JSON.stringify({ level: "info", msg: "admin: alerta del tope vista", admin: admin.email }),
  );
  revalidatePath("/admin");
  redirect("/admin/puntos?ok=puntos");
}

const RemovePoints = z.object({
  tenant_id: z.string().uuid(),
  action_id: z.string().uuid(),
  points: z.coerce.number().int().min(1).max(100_000),
  reason: z.enum(REMOVE_REASONS),
});

/**
 * «Quitar puntos» (US-432, SEC-P4-3, SEC-P4-11): un número entero de 1 al total y un motivo de la
 * lista fija, dentro de `withTenant` del negocio. La clave de la acción hace que repetirla no quite
 * dos veces. `audit_log` con el correo, el motivo y el antes/después. RW8h en la próxima respuesta.
 */
export async function removePointsAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const tenantId = String(formData.get("tenant_id") ?? "");
  const parsed = RemovePoints.safeParse(Object.fromEntries(formData));
  if (!parsed.success) fail(tenantId, "puntos", undefined, "puntos");
  const f = parsed.data;
  const now = new Date();
  let outcome = "ok=puntos";
  try {
    await withTenant(db(), f.tenant_id, async (tx) => {
      const r = await removePoints(
        tx,
        f.tenant_id,
        { actionId: f.action_id, points: f.points, reason: f.reason },
        now,
      );
      if (!r) {
        outcome = "error=puntos";
        return;
      }
      await tx.insert(schema.auditLog).values({
        tenantId: f.tenant_id,
        actorType: "user",
        actorId: admin.userId,
        action: "remove_points",
        entity: "points_event",
        entityId: f.action_id,
        before: { total: r.before },
        after: { total: r.after, reason: f.reason, by: admin.email },
        channel: "admin",
        createdAt: now,
      });
    });
  } catch (err) {
    console.error(
      JSON.stringify({ level: "error", msg: "admin quitar puntos", detail: errorText(err) }),
    );
    outcome = "error=servidor";
  }
  revalidatePath(`/admin/negocios/${f.tenant_id}`);
  back(f.tenant_id, outcome, "puntos");
}

const ReversePayment = z.object({
  tenant_id: z.string().uuid(),
  payment_id: z.string().uuid(),
  reason: z.enum(["devuelto", "contracargo", "error"]),
});

/**
 * «Marcar como devuelto» (US-418, SEC-P4-3, SEC-P4-11): solo un pago aprobado, dentro de
 * `withTenant` del negocio que pagó. No cambia `paid_until` (eso sigue a mano). Mueve el paso de la
 * invitación de ese negocio; el lado del que invita (−100, RW8f, código pausado) lo aplica el
 * barrido del worker. Repetirlo no hace nada.
 */
export async function reversePaymentAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const tenantId = String(formData.get("tenant_id") ?? "");
  const parsed = ReversePayment.safeParse(Object.fromEntries(formData));
  if (!parsed.success) fail(tenantId, "datos", undefined, "pagos");
  const f = parsed.data;
  const now = new Date();
  let outcome = "ok=devuelto";
  try {
    await withTenant(db(), f.tenant_id, async (tx) => {
      const done = await tx
        .update(schema.payment)
        .set({ status: "reversed", reversedAt: now, reversedBy: admin.email })
        .where(
          and(
            eq(schema.payment.id, f.payment_id),
            eq(schema.payment.tenantId, f.tenant_id),
            eq(schema.payment.status, "approved"),
          ),
        )
        .returning({ id: schema.payment.id });
      if (!done[0]) {
        outcome = "error=estado";
        return;
      }
      await tx.insert(schema.auditLog).values({
        tenantId: f.tenant_id,
        actorType: "user",
        actorId: admin.userId,
        action: "reverse_payment",
        entity: "payment",
        entityId: f.payment_id,
        before: { status: "approved" },
        after: { status: "reversed", reason: f.reason, by: admin.email },
        channel: "admin",
        createdAt: now,
      });
      await syncInvitee(tx);
    });
  } catch (err) {
    fail(f.tenant_id, "servidor", err, "pagos");
  }
  back(f.tenant_id, outcome, "pagos");
}

const CodeOp = z.object({ tenant_id: z.string().uuid(), op: z.enum(["disable", "enable"]) });

/**
 * Pausar o reactivar el código de un negocio (US-419, SEC-P4-3, SEC-P4-11): pausar solo uno
 * activo; reactivar solo uno pausado. `audit_log` con el antes y el después (sin el código).
 */
export async function setReferralCodeAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const tenantId = String(formData.get("tenant_id") ?? "");
  const parsed = CodeOp.safeParse(Object.fromEntries(formData));
  if (!parsed.success) fail(tenantId, "datos", undefined, "puntos");
  const f = parsed.data;
  const now = new Date();
  let outcome = "ok=codigo";
  try {
    await withTenant(db(), f.tenant_id, async (tx) => {
      const done = await tx
        .update(schema.referralCode)
        .set(
          f.op === "disable"
            ? { disabledAt: now, disabledReason: "admin" }
            : { disabledAt: null, disabledReason: null },
        )
        .where(
          and(
            eq(schema.referralCode.tenantId, f.tenant_id),
            f.op === "disable"
              ? isNull(schema.referralCode.disabledAt)
              : isNotNull(schema.referralCode.disabledAt),
          ),
        )
        .returning({ id: schema.referralCode.id });
      if (!done[0]) {
        outcome = "error=estado";
        return;
      }
      await tx.insert(schema.auditLog).values({
        tenantId: f.tenant_id,
        actorType: "user",
        actorId: admin.userId,
        action: f.op === "disable" ? "disable_referral_code" : "enable_referral_code",
        entity: "referral_code",
        entityId: done[0].id,
        before: { disabled: f.op === "enable" },
        after: { disabled: f.op === "disable", by: admin.email },
        channel: "admin",
        createdAt: now,
      });
    });
  } catch (err) {
    fail(f.tenant_id, "servidor", err, "puntos");
  }
  back(f.tenant_id, outcome, "puntos");
}

const RefReview = z.object({
  tenant_id: z.string().uuid(),
  grant_id: z.string().uuid(),
  op: z.enum(["approve", "refuse"]),
});

/**
 * Revisión del mes de regalo (US-422, A36, SEC-P4-3, SEC-P4-11): aprobar o rechazar solo desde
 * `pending_review`; aprobar solo 7 días después de aprobado el pago del invitado (lo mira la base).
 * Dentro de `withTenant` de quien invita. `audit_log` con el correo; repetirlo no hace nada.
 */
export async function reviewRefMonthAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = RefReview.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/admin/puntos?error=datos#invitaciones");
  const f = parsed.data;
  const now = new Date();
  let outcome = `ok=${f.op === "approve" ? "mes_aprobado" : "mes_rechazado"}`;
  try {
    await withTenant(db(), f.tenant_id, async (tx) => {
      if (f.op === "approve") await approveRefMonth(tx, f.tenant_id, f.grant_id, admin, now);
      else await refuseRefMonth(tx, f.tenant_id, f.grant_id, now);
      await tx.insert(schema.auditLog).values({
        tenantId: f.tenant_id,
        actorType: "user",
        actorId: admin.userId,
        action: f.op === "approve" ? "approve_ref_month" : "refuse_ref_month",
        entity: "reward_grant",
        entityId: f.grant_id,
        before: { status: "pending_review" },
        after: { op: f.op, by: admin.email },
        channel: "admin",
        createdAt: now,
      });
    });
  } catch (err) {
    if (err instanceof ReviewRefused)
      outcome = `error=${err.reason === "too_soon" ? "mes_pronto" : "estado"}`;
    else {
      console.error(
        JSON.stringify({ level: "error", msg: "admin mes de regalo", detail: errorText(err) }),
      );
      outcome = "error=servidor";
    }
  }
  revalidatePath("/admin");
  redirect(`/admin/puntos?${outcome}#invitaciones`);
}

const FounderMark = z.object({ id: z.string().uuid(), on: z.enum(["1", "0"]) });

/**
 * «Le escribí yo» / «Deshacer» (signup-reminders US-SR-09): el registro queda fuera del recordatorio
 * y del lote. Sin contenido en el log: solo la acción, el admin y el id del registro.
 */
export async function markFounderContactedAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = FounderMark.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/admin/registro?error=servidor");
  const on = parsed.data.on === "1";
  await db()
    .update(schema.signup)
    .set({ founderContactedAt: on ? new Date() : null })
    .where(eq(schema.signup.id, parsed.data.id));
  // audit_log exige un negocio y un registro sin terminar no lo tiene: queda en el log del servidor.
  console.info(
    JSON.stringify({
      level: "info",
      msg: on ? "admin: le escribí yo" : "admin: deshacer le escribí yo",
      admin: admin.email,
      signupId: parsed.data.id,
    }),
  );
  revalidatePath("/admin");
  redirect("/admin/registro?ok=registro#registros");
}

/** Interruptores del recordatorio del registro (SR-ADM). Encender (A) guarda desde cuándo. */
export async function saveSignupRescueAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const inWindow = formData.get("in_window") === "on";
  const template = formData.get("template") === "on";
  const viaTemplate = formData.get("via_template") === "on";
  // «Plantilla (lote)» la enciende solo el lote (a mano solo se apaga, como freno); «como
  // plantilla» no está aprobado (rediseño 08/11, `admin/flags`).
  const flagsBefore = await currentFlags();
  const check = validateFlagSave(flagsBefore, { ...flagsBefore, inWindow, template, viaTemplate });
  if (!check.ok) redirect(`/admin/interruptores?error=${FLAG_ERROR[check.error]}`);
  try {
    await saveSignupRescueSettings(
      db(),
      { inWindow, template, inWindowVia: viaTemplate ? "template" : "text" },
      admin.email,
      new Date(),
    );
  } catch (err) {
    console.error(
      JSON.stringify({ level: "error", msg: "admin registro", detail: errorText(err) }),
    );
    redirect("/admin/interruptores?error=servidor");
  }
  revalidatePath("/admin");
  redirect("/admin/interruptores?ok=rescate");
}

/**
 * «Programar lote» (A-0031, decisión del fundador 05/11): guarda quiénes saldrían ahora y la hora
 * (el próximo martes a jueves a las 10:00) y enciende «Registro: plantilla (lote)». El worker lo
 * corre solo. Sin datos en el log: solo la acción.
 */
export async function scheduleBatchAction(): Promise<void> {
  const admin = await requireAdmin();
  try {
    await scheduleSignupBatch(db(), { actor: admin.email, now: new Date() });
  } catch (err) {
    if (err instanceof BatchRefused)
      redirect(`/admin/registro?error=lote&motivo=${encodeURIComponent(err.reason)}#lote`);
    console.error(JSON.stringify({ level: "error", msg: "admin lote", detail: errorText(err) }));
    redirect("/admin/registro?error=servidor");
  }
  revalidatePath("/admin");
  redirect("/admin/registro?ok=lote_programado#lote");
}

export async function cancelBatchAction(): Promise<void> {
  const admin = await requireAdmin();
  await cancelSignupBatch(db(), admin.email, new Date());
  revalidatePath("/admin");
  redirect("/admin/registro?ok=lote_cancelado#lote");
}
