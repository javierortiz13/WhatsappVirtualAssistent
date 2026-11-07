import { and, type Db, eq, everyTenantId, gte, rows, schema, sql, withTenant } from "@caja/db";
import { formatMoney } from "../domain/money";
import { serviceWindow } from "../inbox/window";
import type { MetaClient } from "../whatsapp/client";
import { planById } from "./plans";

/**
 * Aviso al administrador cuando un cliente reporta un pago (decisión del fundador, 06/11): hoy el
 * pago solo queda «por verificar» en /admin y nadie se entera. Cada minuto el worker mira los
 * pagos pendientes nuevos y le escribe al número del administrador desde el número de Rocco.
 *
 * - Ventana de 24 h abierta (el administrador le escribió a Rocco hace menos de 23,5 h): texto.
 * - Cerrada: la plantilla de utilidad, si está configurada y aprobada por Meta.
 * - Sin ninguna de las dos: no sale nada y se devuelve `no_window` (el worker lo manda a Sentry,
 *   solo la cuenta).
 *
 * El aviso no lleva el nombre del negocio, ni números de teléfono, ni la referencia: plan, meses,
 * método y monto, y el enlace a /admin, donde se ve todo. El número del administrador vive solo
 * en la variable del worker y nunca se imprime. El aviso no se guarda en la conversación del
 * administrador (no es una respuesta de Rocco y no debe verla el asistente).
 */

export const ADMIN_ALERT_KEY = "admin_payment_alert";
/** Pagos ya avisados que se recuerdan: un reporte que tarda en confirmarse no se pierde ni se repite. */
const SEEN_MS = 30 * 60_000;
/** Como mucho estas líneas en un aviso; el resto va como «y N más». */
const MAX_LINES = 5;

const METHOD_LABEL: Record<string, string> = {
  pago_movil: "Pago móvil",
  zelle: "Zelle",
  binance: "Binance",
};

type AlertState = { seen: { id: string; at: string }[]; startedAt: string };

export type AlertPayment = {
  id: string;
  createdAt: Date;
  kind: string;
  plan: string;
  months: number;
  method: string;
  amount: string;
  currency: string;
  extraMessages: number | null;
};

export type PaymentAlertResult =
  | { status: "off" }
  | { status: "none" }
  | {
      status: "sent" | "no_window" | "failed";
      via: "text" | "template" | null;
      newPayments: number;
      pending: number;
    };

/** Una línea por pago: «Plan Negocio · 1 mes · Pago móvil · Bs 1.234,56». */
export function paymentAlertLine(p: AlertPayment): string {
  const what =
    p.kind === "recharge"
      ? `Recarga de ${p.extraMessages ?? 100} mensajes`
      : `Plan ${planById(p.plan).name} · ${p.months} ${p.months === 1 ? "mes" : "meses"}`;
  // Binance llega en USDT: se muestra como dólares con la moneda al lado.
  const money =
    p.currency === "VES" || p.currency === "USD"
      ? formatMoney(p.amount, p.currency)
      : `${formatMoney(p.amount, "USD")} ${p.currency}`;
  return `${what} · ${METHOD_LABEL[p.method] ?? p.method} · ${money}`;
}

/** El texto del aviso (ventana abierta). */
export function paymentAlertText(
  fresh: AlertPayment[],
  pending: number,
  adminUrl: string,
  firstRun: boolean,
): string {
  const head = firstRun
    ? `Hay ${pending} ${pending === 1 ? "pago" : "pagos"} por verificar.`
    : fresh.length === 1
      ? "Nuevo pago por verificar:"
      : `${fresh.length} pagos nuevos por verificar:`;
  const lines = fresh.slice(0, MAX_LINES).map((p) => `• ${paymentAlertLine(p)}`);
  if (fresh.length > MAX_LINES) lines.push(`• y ${fresh.length - MAX_LINES} más`);
  const total = !firstRun && pending > fresh.length ? [`Por verificar en total: ${pending}.`] : [];
  return [head, ...lines, ...total, `Revísalos en ${adminUrl}`].join("\n");
}

/** El parámetro de la plantilla: una sola línea (Meta no acepta saltos de línea). */
export function paymentAlertParam(fresh: AlertPayment[]): string {
  const first = fresh[0];
  if (!first) return "";
  const more = fresh.length > 1 ? ` (y ${fresh.length - 1} más)` : "";
  return `${paymentAlertLine(first)}${more}`;
}

async function readState(db: Db): Promise<AlertState | null> {
  const [r] = await db
    .select({ value: schema.appSetting.value })
    .from(schema.appSetting)
    .where(eq(schema.appSetting.key, ADMIN_ALERT_KEY));
  return (r?.value as AlertState | undefined) ?? null;
}

async function saveState(db: Db, value: AlertState, now: Date): Promise<void> {
  await db
    .insert(schema.appSetting)
    .values({ key: ADMIN_ALERT_KEY, value, updatedAt: now, updatedBy: "aviso de pagos" })
    .onConflictDoUpdate({
      target: schema.appSetting.key,
      set: { value, updatedAt: now, updatedBy: "aviso de pagos" },
    });
}

/** Los pagos pendientes de todos los negocios (bajo RLS, uno a uno, como /admin). */
async function pendingPayments(db: Db, since: Date | null): Promise<AlertPayment[]> {
  const out: AlertPayment[] = [];
  const p = schema.payment;
  for (const id of await everyTenantId(db)) {
    const found = await withTenant(db, id, (tx) =>
      tx
        .select({
          id: p.id,
          createdAt: p.createdAt,
          kind: p.kind,
          plan: p.plan,
          months: p.months,
          method: p.method,
          amount: p.amount,
          currency: p.currency,
          extraMessages: p.extraMessages,
        })
        .from(p)
        .where(
          and(
            eq(p.tenantId, id),
            eq(p.status, "pending"),
            ...(since ? [gte(p.createdAt, since)] : []),
          ),
        ),
    );
    out.push(...found.map((r) => ({ ...r, amount: String(r.amount) })));
  }
  return out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

async function pendingCount(db: Db): Promise<number> {
  return (await pendingPayments(db, null)).length;
}

/** ¿El administrador le escribió a Rocco hace menos de 23,5 h? */
async function adminWindowOpen(db: Db, e164: string, now: Date): Promise<boolean> {
  const [r] = rows<{ phone_id: string; tenant_id: string }>(
    await db.execute(sql`select phone_id, tenant_id from app.resolve_phone(${e164}, null)`),
  );
  if (!r) return false;
  const w = await withTenant(db, r.tenant_id, (tx) => serviceWindow(tx, r.phone_id, now));
  return w.open;
}

/**
 * Una vuelta (cada minuto). La primera vez que corre con el número configurado avisa cuántos
 * pagos hay por verificar (si hay alguno); después, solo los nuevos.
 */
export async function runPaymentAlerts(
  db: Db,
  meta: MetaClient | null,
  opts: {
    /** Número del administrador (E.164, solo dígitos). Sin él, no hace nada. */
    adminE164: string | null;
    /** Plantilla de utilidad aprobada, para cuando la ventana está cerrada. */
    template: { name: string; language: string } | null;
    dashboardUrl: string;
    now: Date;
  },
): Promise<PaymentAlertResult> {
  const to = opts.adminE164?.replace(/\D/g, "") || null;
  if (!to || !meta) return { status: "off" };
  const now = opts.now;
  const state = await readState(db);
  const firstRun = state === null;
  const seenFrom = new Date(now.getTime() - SEEN_MS);
  const seen = new Set((state?.seen ?? []).map((s) => s.id));
  const recent = await pendingPayments(db, firstRun ? null : seenFrom);
  const fresh = recent.filter((p) => !seen.has(p.id));
  const keep = (list: AlertPayment[]) =>
    list
      .filter((p) => p.createdAt.getTime() >= seenFrom.getTime())
      .map((p) => ({ id: p.id, at: p.createdAt.toISOString() }));
  // Se recuerdan los avisados de los últimos 30 min (los de antes ya no entran en la consulta).
  const nextState: AlertState = {
    seen: [
      ...(state?.seen ?? []).filter((s) => new Date(s.at).getTime() >= seenFrom.getTime()),
      ...keep(fresh),
    ],
    startedAt: state?.startedAt ?? now.toISOString(),
  };
  if (!fresh.length) {
    if (firstRun) await saveState(db, nextState, now);
    return { status: "none" };
  }
  const pending = firstRun ? fresh.length : await pendingCount(db);
  const adminUrl = `${opts.dashboardUrl.replace(/\/$/, "")}/admin`;
  // Se guarda antes de enviar: un error de Meta no repite el aviso cada minuto (va a Sentry).
  await saveState(db, nextState, now);
  try {
    if (await adminWindowOpen(db, to, now)) {
      await meta.sendText(to, paymentAlertText(fresh, pending, adminUrl, firstRun));
      return { status: "sent", via: "text", newPayments: fresh.length, pending };
    }
    if (opts.template) {
      await meta.sendTemplate(to, opts.template.name, opts.template.language, [
        paymentAlertParam(fresh),
      ]);
      return { status: "sent", via: "template", newPayments: fresh.length, pending };
    }
    return { status: "no_window", via: null, newPayments: fresh.length, pending };
  } catch {
    return { status: "failed", via: null, newPayments: fresh.length, pending };
  }
}
