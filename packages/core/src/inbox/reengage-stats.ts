import { type Db, eq, rows, schema, sql, type Tx } from "@caja/db";
import { businessDateOf } from "../domain/dates";
import { NIGHT_VARIANTS, type NightVariant } from "../render/es-VE";
import { NUDGE_MARK, REENGAGE_T_MARK } from "./nudge";
import { REASK_TEMPLATE_MARK, REENGAGE_ASK_MARK } from "./prefs";
import { REENGAGE_RUN_MAX } from "./reengage";

/**
 * Los números de la retención E1–E3 para /admin (agencia 19/11 §1.9, §2, §7.5). Solo conteos de
 * un negocio desde `since`: nunca un teléfono, un nombre ni un texto. Se suman con
 * `sumReengageStats`.
 */
export type TemplateStats = {
  sent: number;
  delivered: number;
  held: number;
  failed: number;
  /** Fallidos por código de Meta (al enviar o por el webhook); «otro» sin código. */
  failedByCode: Record<string, number>;
};

export type ReengageStats = {
  e1: TemplateStats & {
    /** Dueños que hoy podrían recibirla (con el «Sí», sin nada apagado ni en pausa). */
    eligibleNow: number;
    /** De las enviadas, las seguidas de un día cumplido (registro o «sin gastos») en 24 h. */
    keptWithin24h: number;
    taps: { expense: number; noSpend: number; stop: number };
    /** «No me escribas» desde la plantilla (auditoría E1-A). */
    stopFromTemplate: number;
    /** Corridas que llegaron a 3 plantillas sin respuesta. */
    runsCutAt3: number;
    /** Plantillas del mes de Caracas que cuentan para el tope (enviadas y retenidas). */
    monthTemplates: number;
  };
  e2: Record<NightVariant, { sent: number; keptWithin2h: number; nudgeOffs: number }>;
  e3: {
    shown: { E3: number; "E3-n": number; "E3-r": number };
    yes: number;
    no: number;
    /** Teléfonos a los que se les mostró alguna pregunta en una tarjeta y no contestaron. */
    noAnswer: number;
  };
  e3t: TemplateStats & { yes: number; no: number; stop: number; noAnswer72h: number };
};

const emptyTemplate = (): TemplateStats => ({
  sent: 0,
  delivered: 0,
  held: 0,
  failed: 0,
  failedByCode: {},
});

export function emptyReengageStats(): ReengageStats {
  return {
    e1: {
      ...emptyTemplate(),
      eligibleNow: 0,
      keptWithin24h: 0,
      taps: { expense: 0, noSpend: 0, stop: 0 },
      stopFromTemplate: 0,
      runsCutAt3: 0,
      monthTemplates: 0,
    },
    e2: Object.fromEntries(
      NIGHT_VARIANTS.map((v) => [v, { sent: 0, keptWithin2h: 0, nudgeOffs: 0 }]),
    ) as ReengageStats["e2"],
    e3: { shown: { E3: 0, "E3-n": 0, "E3-r": 0 }, yes: 0, no: 0, noAnswer: 0 },
    e3t: { ...emptyTemplate(), yes: 0, no: 0, stop: 0, noAnswer72h: 0 },
  };
}

type Out = {
  id: string;
  phoneId: string;
  at: Date;
  status: string;
  waMessageId: string | null;
  toolCalls: unknown;
};

const callOf = (tc: unknown, name: string) =>
  ((Array.isArray(tc) ? tc : []) as { name?: string; args?: Record<string, unknown> }[]).find(
    (c) => c.name === name,
  );

/** Enviadas, entregadas, retenidas y fallidas (con su código) de una plantilla. */
async function templateCounts(tx: Tx, list: Out[], name: string): Promise<TemplateStats> {
  const s = emptyTemplate();
  const bump = (code: unknown) => {
    const k = typeof code === "number" ? String(code) : "otro";
    s.failedByCode[k] = (s.failedByCode[k] ?? 0) + 1;
  };
  const keys = list
    .map((o) => o.waMessageId)
    .filter((x): x is string => Boolean(x))
    .flatMap((w) => [`status:${w}:delivered`, `status:${w}:failed`]);
  const events = keys.length
    ? rows<{ key: string; payload: { errors?: { code?: number | null }[] } | null }>(
        await tx.execute(sql`
          select event_key as key, payload from app.webhook_event
          where event_key in (${sql.join(
            keys.map((k) => sql`${k}`),
            sql`, `,
          )})
        `),
      )
    : [];
  const delivered = new Set(events.filter((e) => e.key.endsWith(":delivered")).map((e) => e.key));
  const failedLate = new Map(
    events.filter((e) => e.key.endsWith(":failed")).map((e) => [e.key, e.payload] as const),
  );
  for (const o of list) {
    const args = callOf(o.toolCalls, name)?.args ?? {};
    if (o.status === "failed" || o.status === "limited") {
      s.failed += 1;
      bump(args.code);
      continue;
    }
    if (o.status !== "ok") continue;
    if (args.held) s.held += 1;
    else s.sent += 1;
    if (o.waMessageId && delivered.has(`status:${o.waMessageId}:delivered`)) s.delivered += 1;
    const late = o.waMessageId ? failedLate.get(`status:${o.waMessageId}:failed`) : undefined;
    if (late !== undefined) {
      s.failed += 1;
      bump(late?.errors?.[0]?.code ?? null);
    }
  }
  return s;
}

/** Instantes de los días cumplidos del negocio: movimientos creados y «sin gastos». */
async function keptMoments(tx: Tx, tenantId: string, since: Date): Promise<number[]> {
  const found = rows<{ at: string | Date }>(
    await tx.execute(sql`
      select created_at as at from app.movement
      where tenant_id = ${tenantId} and created_at > ${since.toISOString()}::timestamptz
      union all
      select created_at as at from app.no_spend_day
      where tenant_id = ${tenantId} and created_at > ${since.toISOString()}::timestamptz
    `),
  );
  return found.map((r) => new Date(r.at).getTime()).sort((a, b) => a - b);
}

const within = (moments: number[], from: number, ms: number) =>
  moments.some((t) => t >= from && t <= from + ms);

export async function reengageStats(
  tx: Tx,
  tenantId: string,
  since: Date,
  now: Date,
): Promise<ReengageStats> {
  const out = emptyReengageStats();
  const m = schema.message;
  const marked = (name: string) => sql`${m.toolCalls} @> ${JSON.stringify([{ name }])}::jsonb`;
  const outs = (await tx
    .select({
      id: m.id,
      phoneId: m.phoneId,
      at: m.createdAt,
      status: m.status,
      waMessageId: m.waMessageId,
      toolCalls: m.toolCalls,
    })
    .from(m)
    .where(
      sql`${m.tenantId} = ${tenantId} and ${m.direction} = 'out'
          and ${m.createdAt} > ${since.toISOString()}::timestamptz
          and (${marked(REENGAGE_T_MARK)} or ${marked(REASK_TEMPLATE_MARK)}
               or ${marked(REENGAGE_ASK_MARK)} or ${marked(NUDGE_MARK)})`,
    )) as Out[];
  const e1 = outs.filter((o) => callOf(o.toolCalls, REENGAGE_T_MARK));
  const e3t = outs.filter((o) => callOf(o.toolCalls, REASK_TEMPLATE_MARK));
  const kept = await keptMoments(tx, tenantId, since);

  // ---- E1
  Object.assign(out.e1, await templateCounts(tx, e1, REENGAGE_T_MARK));
  out.e1.keptWithin24h = e1.filter(
    (o) => o.status === "ok" && within(kept, o.at.getTime(), 24 * 3_600_000),
  ).length;
  const first = `${businessDateOf(now).slice(0, 8)}01`;
  const [month] = rows<{ n: number }>(
    await tx.execute(sql`
      select count(*)::int as n from app.message
      where tenant_id = ${tenantId} and direction = 'out' and status in ('ok', 'unknown', 'sending')
        and tool_calls @> ${JSON.stringify([{ name: REENGAGE_T_MARK }])}::jsonb
        and created_at >= (${first}::date::timestamp at time zone 'America/Caracas')
    `),
  );
  out.e1.monthTemplates = month?.n ?? 0;
  // Toques: el mensaje entrante que responde (contexto de WhatsApp) a una plantilla.
  const taps = async (wa: string[]) =>
    wa.length
      ? rows<{ reply: string | null }>(
          await tx.execute(sql`
            select e.payload->>'replyId' as reply from app.message i
            join app.webhook_event e on e.id = i.webhook_event_id
            where i.tenant_id = ${tenantId} and i.direction = 'in'
              and e.payload->>'replyTo' in (${sql.join(
                wa.map((w) => sql`${w}`),
                sql`, `,
              )})
          `),
        ).map((r) => r.reply ?? "")
      : [];
  const waOf = (list: Out[]) => list.map((o) => o.waMessageId).filter((x): x is string => !!x);
  for (const r of await taps(waOf(e1))) {
    if (r === "menu:expense") out.e1.taps.expense += 1;
    else if (r.startsWith("habit:nospend:")) out.e1.taps.noSpend += 1;
    else if (r === "pref:yes:all_off") out.e1.taps.stop += 1;
  }
  // Corridas: plantillas seguidas sin un mensaje suyo entre ellas, por teléfono.
  const ins = rows<{ phone: string; at: string | Date }>(
    await tx.execute(sql`
      select phone_id as phone, created_at as at from app.message
      where tenant_id = ${tenantId} and direction = 'in' and created_at > ${since.toISOString()}::timestamptz
    `),
  );
  const byPhone = new Map<string, { at: number; t: "in" | "out" }[]>();
  for (const i of ins)
    byPhone.set(i.phone, [
      ...(byPhone.get(i.phone) ?? []),
      { at: new Date(i.at).getTime(), t: "in" },
    ]);
  for (const o of e1.filter((x) => x.status === "ok" || x.status === "unknown"))
    byPhone.set(o.phoneId, [...(byPhone.get(o.phoneId) ?? []), { at: o.at.getTime(), t: "out" }]);
  for (const list of byPhone.values()) {
    let run = 0;
    for (const ev of list.sort((a, b) => a.at - b.at)) {
      if (ev.t === "in") run = 0;
      else if (++run === REENGAGE_RUN_MAX) out.e1.runsCutAt3 += 1;
    }
  }

  // ---- auditoría (consentimientos): solo el id del texto
  const a = schema.auditLog;
  const audits = await tx
    .select({ action: a.action, after: a.after, at: a.createdAt, phone: a.entityId })
    .from(a)
    .where(
      sql`${a.tenantId} = ${tenantId} and ${a.createdAt} > ${since.toISOString()}::timestamptz
          and ${a.action} in ('reengage_opt_in', 'reengage_declined', 'all_off', 'nudge_off')`,
    );
  const textId = (x: unknown) => (x as { text_id?: string } | null)?.text_id ?? "";
  out.e1.stopFromTemplate = audits.filter(
    (x) => x.action === "all_off" && textId(x.after) === "E1-A",
  ).length;

  // ---- E2: por arranque
  const nights = outs.filter((o) => {
    const c = callOf(o.toolCalls, NUDGE_MARK);
    return c && !c.args?.ask && o.status === "ok";
  });
  const variantOf = (o: Out): NightVariant => {
    const v = String(callOf(o.toolCalls, NUDGE_MARK)?.args?.v ?? "N1");
    return (NIGHT_VARIANTS as string[]).includes(v) ? (v as NightVariant) : "N1";
  };
  for (const o of nights) {
    const row = out.e2[variantOf(o)];
    row.sent += 1;
    if (within(kept, o.at.getTime(), 2 * 3_600_000)) row.keptWithin2h += 1;
  }
  // «No me recuerdes» en las 24 h después de un mensaje de la noche: al último que le llegó.
  for (const x of audits.filter((y) => y.action === "nudge_off")) {
    const before = nights
      .filter(
        (o) =>
          o.phoneId === x.phone &&
          o.at.getTime() <= x.at.getTime() &&
          x.at.getTime() - o.at.getTime() <= 24 * 3_600_000,
      )
      .sort((p, q) => q.at.getTime() - p.at.getTime())[0];
    if (before) out.e2[variantOf(before)].nudgeOffs += 1;
  }

  // ---- E3: preguntas en la tarjeta
  const asks = outs.filter(
    (o) => callOf(o.toolCalls, REENGAGE_ASK_MARK) && (o.status === "ok" || o.status === "unknown"),
  );
  const askPhones = new Set<string>();
  for (const o of asks) {
    const v = String(callOf(o.toolCalls, REENGAGE_ASK_MARK)?.args?.v ?? "");
    if (v === "E3" || v === "E3-n" || v === "E3-r") out.e3.shown[v] += 1;
    askPhones.add(o.phoneId);
  }
  const cardIds = ["E3", "E3-n", "E3-r"];
  const answered = new Set<string>();
  for (const x of audits) {
    const id = textId(x.after);
    if (x.action === "reengage_opt_in" && cardIds.includes(id)) out.e3.yes += 1;
    if (x.action === "reengage_declined" && cardIds.includes(id)) out.e3.no += 1;
    if ((x.action === "reengage_opt_in" || x.action === "reengage_declined") && x.phone)
      answered.add(x.phone);
  }
  out.e3.noAnswer = [...askPhones].filter((p) => !answered.has(p)).length;

  // ---- E3-t: la plantilla que pregunta
  Object.assign(out.e3t, await templateCounts(tx, e3t, REASK_TEMPLATE_MARK));
  for (const x of audits) {
    if (textId(x.after) !== "E3-t") continue;
    if (x.action === "reengage_opt_in") out.e3t.yes += 1;
    if (x.action === "reengage_declined") out.e3t.no += 1;
    if (x.action === "all_off") out.e3t.stop += 1;
  }
  const H72 = 72 * 3_600_000;
  for (const o of e3t.filter((x) => x.status === "ok")) {
    if (now.getTime() - o.at.getTime() < H72) continue;
    const replied = ins.some((i) => {
      const t = new Date(i.at).getTime();
      return i.phone === o.phoneId && t > o.at.getTime() && t <= o.at.getTime() + H72;
    });
    if (!replied) out.e3t.noAnswer72h += 1;
  }

  // ---- E1: quién podría recibirla hoy
  const p = schema.phoneNumber;
  const owners = await tx
    .select({
      off: p.nudgeOffAt,
      all: p.unsolicitedOffAt,
      pending: p.prefPending,
      until: p.nudgePausedUntil,
      at: p.reengageOptInAt,
    })
    .from(p)
    .where(
      sql`${p.tenantId} = ${tenantId} and ${p.role} = 'owner' and ${p.status} = 'active'
          and ${p.reengageOptInAt} is not null`,
    );
  const [t] = await tx
    .select({ tags: schema.tenant.crmTags })
    .from(schema.tenant)
    .where(eq(schema.tenant.id, tenantId));
  const tagged = (t?.tags ?? []).some((g) => g.trim().toLowerCase() === "no-contactar");
  if (!tagged)
    out.e1.eligibleNow = owners.filter(
      (o) => !o.off && !o.all && !o.pending && !(o.until && o.until.getTime() > now.getTime()),
    ).length;
  return out;
}

export function sumReengageStats(list: ReengageStats[]): ReengageStats {
  const out = emptyReengageStats();
  const addCodes = (to: Record<string, number>, from: Record<string, number>) => {
    for (const [k, v] of Object.entries(from)) to[k] = (to[k] ?? 0) + v;
  };
  for (const s of list) {
    for (const k of [
      "sent",
      "delivered",
      "held",
      "failed",
      "eligibleNow",
      "keptWithin24h",
      "stopFromTemplate",
      "runsCutAt3",
      "monthTemplates",
    ] as const)
      out.e1[k] += s.e1[k];
    addCodes(out.e1.failedByCode, s.e1.failedByCode);
    for (const k of ["expense", "noSpend", "stop"] as const) out.e1.taps[k] += s.e1.taps[k];
    for (const v of NIGHT_VARIANTS)
      for (const k of ["sent", "keptWithin2h", "nudgeOffs"] as const) out.e2[v][k] += s.e2[v][k];
    for (const k of ["E3", "E3-n", "E3-r"] as const) out.e3.shown[k] += s.e3.shown[k];
    for (const k of ["yes", "no", "noAnswer"] as const) out.e3[k] += s.e3[k];
    for (const k of [
      "sent",
      "delivered",
      "held",
      "failed",
      "yes",
      "no",
      "stop",
      "noAnswer72h",
    ] as const)
      out.e3t[k] += s.e3t[k];
    addCodes(out.e3t.failedByCode, s.e3t.failedByCode);
  }
  return out;
}

// ---------------------------------------------------------------- saltos por razón (globales)

const SKIPS_KEY = "reengage_skips";
const SKIPS_DAYS = 35;

/**
 * Los saltos de E1 por razón, por día de Caracas: cada teléfono cuenta una vez por razón y día
 * (las vueltas de 5 min no se suman). Se guardan ids internos de teléfono, nunca números; /admin
 * muestra solo las cuentas. «not_due» (no era su hora) no se guarda.
 */
export async function recordReengageSkips(
  db: Db,
  now: Date,
  skips: { phoneId: string; reason: string }[],
): Promise<void> {
  const list = skips.filter((s) => s.reason !== "not_due");
  if (!list.length) return;
  const day = businessDateOf(now);
  const [r] = await db
    .select({ value: schema.appSetting.value })
    .from(schema.appSetting)
    .where(eq(schema.appSetting.key, SKIPS_KEY));
  const all = (r?.value ?? {}) as Record<string, Record<string, string[]>>;
  const today = all[day] ?? {};
  for (const s of list) {
    const ids = new Set(today[s.reason] ?? []);
    ids.add(s.phoneId);
    today[s.reason] = [...ids];
  }
  const kept = Object.keys(all)
    .sort()
    .slice(-(SKIPS_DAYS - 1))
    .filter((d) => d !== day);
  const value = { ...Object.fromEntries(kept.map((d) => [d, all[d]])), [day]: today };
  await db
    .insert(schema.appSetting)
    .values({ key: SKIPS_KEY, value, updatedAt: now, updatedBy: "reengage" })
    .onConflictDoUpdate({ target: schema.appSetting.key, set: { value, updatedAt: now } });
}

/** Saltos por razón desde el día `fromDay` (incluido): solo cuentas. */
export async function reengageSkipCounts(db: Db, fromDay: string): Promise<Record<string, number>> {
  const [r] = await db
    .select({ value: schema.appSetting.value })
    .from(schema.appSetting)
    .where(eq(schema.appSetting.key, SKIPS_KEY));
  const all = (r?.value ?? {}) as Record<string, Record<string, string[]>>;
  const out: Record<string, number> = {};
  for (const [day, reasons] of Object.entries(all))
    if (day >= fromDay)
      for (const [reason, ids] of Object.entries(reasons))
        out[reason] = (out[reason] ?? 0) + ids.length;
  return out;
}

/** Lo que el worker usó en su última vuelta (tope y tarifa), para «costo del mes vs tope». */
export async function reengageCapState(
  db: Db,
): Promise<{ capUsd: number | null; rateUsd: number | null }> {
  const [r] = await db
    .select({ value: schema.appSetting.value })
    .from(schema.appSetting)
    .where(eq(schema.appSetting.key, "reengage_state"));
  const v = (r?.value ?? {}) as { capUsd?: number | null; rateUsd?: number | null };
  return { capUsd: v.capUsd ?? null, rateUsd: v.rateUsd ?? null };
}
