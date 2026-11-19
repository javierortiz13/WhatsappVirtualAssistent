import { and, desc, eq, inArray, schema, sql, type Tx } from "@caja/db";
import { habitSettings, nudgeByDefault, reengageOn } from "../ledger/habits";
import {
  type ConsentTextId,
  consentTextVersion,
  consentVersionOf,
  type ReengageAskId,
} from "../render/es-VE";
import { es, type Outbound, parseReplyId } from "../render/index";
import { USUAL_DEFAULT, usualMinute } from "./usual-hour";

/**
 * Apagar y encender avisos (PRD hábitos US-204, US-211, D3, D10). Determinista, sin la IA, sobre
 * el mensaje entero. Va antes de la cuenta suspendida o sin mensajes: un «no me escribas» siempre
 * funciona. Solo con el interruptor `habits.prefs`.
 *
 * - «no me recuerdes» → tarjeta H45 (o H45-n); «no me escribas» → H46. Desde que sale la tarjeta,
 *   lo que apagaría el «Sí» ya no se manda (`pref_pending`), hasta que conteste o encienda.
 * - «Sí, apágalos» vale en cualquier momento; «No, déjalos» quita lo pendiente de esa tarjeta.
 * - Encender no pide confirmación: la respuesta dice qué quedó encendido y cómo apagarlo.
 * - Cada cambio guarda en `audit_log` el id del texto que la persona vio y su versión; nunca lo
 *   que escribió.
 */

export type PrefIntent = "nudges_off" | "all_off" | "nudges_on" | "all_on" | "both_on" | "status";

const PHRASES: Record<PrefIntent, string[]> = {
  nudges_off: [
    "no me recuerdes",
    "no me recuerdes mas",
    "no me avises",
    "apaga el aviso",
    "apaga la racha",
    "apaga los avisos",
    // G1-8 (revisión retroactiva, 05/11) y el mensaje de las 8 pm (MF-4 b).
    "ya no me recuerdes",
    "ya no me avises",
    "no me mandes avisos",
    "no quiero avisos",
    "no me mandes recordatorios",
    "no quiero recordatorios",
    "no me escribas a las 8",
    "no me escribas a las 8 pm",
    "no me mandes el mensaje de las 8",
    "no quiero el mensaje de las 8",
    "no me mandes el resumen de las 8",
    // «El mensaje de la noche» (10/11, d536ca5 + 1A): el nombre nuevo también lo apaga.
    "no me escribas en la noche",
    "no me mandes el mensaje de la noche",
    "no quiero el mensaje de la noche",
  ],
  all_off: [
    "no me escribas",
    "no me escribas mas",
    "deja de escribirme",
    "stop",
    "para",
    "parar",
    "baja",
    "ya no quiero mensajes",
    "no quiero mensajes",
    // G1-8.
    "no me mandes mensajes",
    "no me mandes mas mensajes",
    "no me envies mensajes",
    "no me envies mas mensajes",
    "ya no me escribas",
    "no quiero que me escribas",
    "dejame de escribir",
  ],
  nudges_on: [
    "avisame a las 8",
    "avisame a las 8 pm",
    "avisame a las 8pm",
    // H8 «Avísame en la noche» (10/11): el botón escrito a mano.
    "avisame en la noche",
    "activa el aviso",
    "activa el aviso de racha",
    "enciende el aviso",
  ],
  all_on: ["ya puedes escribirme", "puedes escribirme", "activa los mensajes"],
  both_on: ["activame los avisos", "activa los avisos", "enciende los avisos", "quiero los avisos"],
  status: ["mis avisos", "avisos", "notificaciones", "mis notificaciones"],
};

/** Sin tildes, en minúsculas, sin puntuación y con un solo espacio. */
function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const BY_PHRASE = new Map<string, PrefIntent>(
  (Object.entries(PHRASES) as [PrefIntent, string[]][]).flatMap(([intent, list]) =>
    list.map((p) => [p, intent] as const),
  ),
);

/** La intención de todo el mensaje, o null. «para la luz 20$» no es «para». */
export function classifyPref(text: string): PrefIntent | null {
  // G1-8: «no me escribas más, por favor» es lo mismo que «no me escribas más».
  const t = normalize(text).replace(/\s+(por favor|porfa|porfavor|gracias)$/, "");
  return BY_PHRASE.get(t) ?? null;
}

export const NO_CONTACT_TAG = "no-contactar";

export type PrefState = {
  nudgeOptInAt: Date | null;
  nudgeOffAt: Date | null;
  unsolicitedOffAt: Date | null;
  nudgePausedUntil: Date | null;
  prefPending: "nudges_off" | "all_off" | null;
  /** Etiqueta `no-contactar` del CRM: todo apagado y solo se quita en /admin. */
  tagged: boolean;
  /** Retención E3 (0039): «Sí, recuérdame» (consentimiento de la plantilla E1) o «No, gracias». */
  reengageOptInAt: Date | null;
  reengageDeclinedAt: Date | null;
};

/**
 * Con el mensaje de las 8 pm para todos (`habits.dailyClose`) y 1B (05/11), quien nunca lo aceptó
 * recibe uno, que pregunta. Mientras esa pregunta sigue abierta (todavía no salió, o salió hace
 * menos de 24 h), las tarjetas y «mis avisos» lo cuentan como encendido (H45 y no H45-n, estado
 * A). Después, sin su «Sí», ya no le llega: cuenta como apagado. La columna no se toca: solo
 * la muestra. Encender («Sí, escríbeme», «avísame a las 8») usa siempre el estado real.
 */
export function withDefaultNudge(s: PrefState, askOpen: boolean): PrefState {
  return askOpen && !s.nudgeOptInAt ? { ...s, nudgeOptInAt: new Date(0) } : s;
}

/** ¿Sigue abierta la pregunta de 1B para este teléfono? (Con `dailyClose`; ver arriba.) */
export async function eveningAskOpen(tx: Tx, phoneId: string, now: Date): Promise<boolean> {
  const m = schema.message;
  const [first] = await tx
    .select({ at: m.createdAt })
    .from(m)
    .where(
      and(
        eq(m.phoneId, phoneId),
        eq(m.direction, "out"),
        // DC-9: «unknown» (sin respuesta de Meta) cuenta como enviado.
        inArray(m.status, ["ok", "unknown"]),
        sql`(${m.toolCalls} @> '[{"name":"habit_nudge"}]'::jsonb
             or ${m.toolCalls} @> '[{"name":"habit_close"}]'::jsonb)`,
      ),
    )
    .orderBy(m.createdAt)
    .limit(1);
  return !first || now.getTime() - first.at.getTime() < 24 * 3_600_000;
}

export async function prefState(tx: Tx, phoneId: string, tenantId: string): Promise<PrefState> {
  const [p] = await tx
    .select({
      nudgeOptInAt: schema.phoneNumber.nudgeOptInAt,
      nudgeOffAt: schema.phoneNumber.nudgeOffAt,
      unsolicitedOffAt: schema.phoneNumber.unsolicitedOffAt,
      nudgePausedUntil: schema.phoneNumber.nudgePausedUntil,
      prefPending: schema.phoneNumber.prefPending,
      reengageOptInAt: schema.phoneNumber.reengageOptInAt,
      reengageDeclinedAt: schema.phoneNumber.reengageDeclinedAt,
    })
    .from(schema.phoneNumber)
    .where(eq(schema.phoneNumber.id, phoneId));
  const [t] = await tx
    .select({ tags: schema.tenant.crmTags })
    .from(schema.tenant)
    .where(eq(schema.tenant.id, tenantId));
  const pending = p?.prefPending;
  return {
    nudgeOptInAt: p?.nudgeOptInAt ?? null,
    nudgeOffAt: p?.nudgeOffAt ?? null,
    unsolicitedOffAt: p?.unsolicitedOffAt ?? null,
    nudgePausedUntil: p?.nudgePausedUntil ?? null,
    prefPending: pending === "nudges_off" || pending === "all_off" ? pending : null,
    tagged: (t?.tags ?? []).some((g) => g.trim().toLowerCase() === NO_CONTACT_TAG),
    reengageOptInAt: p?.reengageOptInAt ?? null,
    reengageDeclinedAt: p?.reengageDeclinedAt ?? null,
  };
}

export type PrefCtx = {
  tenantId: string;
  phoneId: string;
  role: "owner" | "employee";
  /** Cuenta suspendida, prueba en su tope o mes en su tope: se guarda, pero no sale nada (R-2 a). */
  held: boolean;
  privacyContact: string;
  now: Date;
  /** El mensaje entrante (wa id), para la ✅ sobre el toque de «Avísame a las 8» (US-206). */
  inboundId?: string;
  /**
   * El mensaje de Rocco al que responde (contexto de WhatsApp): dice si el toque vino de una
   * plantilla (E1, E3-t), para auditar el texto que vio.
   */
  replyTo?: string | null;
};

export type PrefResult = { outbound: Outbound[]; toolCalls: { name: string; args: unknown }[] };
const reply = (out: Outbound, toolCalls: PrefResult["toolCalls"] = []): PrefResult => ({
  outbound: [out],
  toolCalls,
});

type PhoneChange = Partial<{
  nudgeOptInAt: Date | null;
  nudgeOffAt: Date | null;
  unsolicitedOffAt: Date | null;
  nudgePausedUntil: Date | null;
  prefPending: "nudges_off" | "all_off" | null;
  prefPendingAt: Date | null;
  reengageOptInAt: Date | null;
  reengageDeclinedAt: Date | null;
  reengageMinute: number | null;
}>;

async function setPhone(tx: Tx, phoneId: string, change: PhoneChange): Promise<void> {
  await tx.update(schema.phoneNumber).set(change).where(eq(schema.phoneNumber.id, phoneId));
}

type ConsentAction =
  | "nudge_opt_in"
  | "nudge_off"
  | "all_off"
  | "all_on"
  | "reengage_opt_in"
  | "reengage_declined"
  | "reengage_off";

/**
 * Consentimiento (US-201, F2-4): qué texto vio y su versión. Nunca lo que escribió. `reengage`:
 * `habits.reengageAsk` encendido (H45 y H46 llevan la viñeta de E1 y su versión nueva).
 */
async function audit(
  tx: Tx,
  c: PrefCtx,
  action: ConsentAction,
  textId: ConsentTextId,
  source: "word" | "button",
  reengage = false,
): Promise<void> {
  await tx.insert(schema.auditLog).values({
    tenantId: c.tenantId,
    actorType: "phone",
    actorId: c.phoneId,
    action,
    entity: "phone_number",
    entityId: c.phoneId,
    after: { source, text_id: textId, text_version: consentVersionOf(textId, reengage) },
    channel: "whatsapp",
  });
}

/** Marcas de lo que pregunta E3 en una tarjeta (E3, E3-n, E3-r) y de la plantilla E3-t. */
export const REENGAGE_ASK_MARK = "reengage_ask";
export const REASK_TEMPLATE_MARK = "reengage_ask_t";
/** Marca de la plantilla E1. */
export const REENGAGE_TEMPLATE_MARK = "reengage_t";

type MarkCall = { name?: string; args?: { v?: string } };

/**
 * El mensaje de Rocco al que responde este toque, si es suyo y lleva una de las marcas de E1/E3:
 * la marca y, para E3, la variante. null si no responde a ninguno.
 */
async function repliedMark(
  tx: Tx,
  phoneId: string,
  replyTo: string | null | undefined,
): Promise<{ name: string; v?: string } | null> {
  if (!replyTo) return null;
  const [m] = await tx
    .select({ toolCalls: schema.message.toolCalls })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.phoneId, phoneId),
        eq(schema.message.direction, "out"),
        eq(schema.message.waMessageId, replyTo),
      ),
    )
    .limit(1);
  const calls = (Array.isArray(m?.toolCalls) ? m.toolCalls : []) as MarkCall[];
  const hit = calls.find(
    (x) =>
      x.name === REENGAGE_ASK_MARK ||
      x.name === REASK_TEMPLATE_MARK ||
      x.name === REENGAGE_TEMPLATE_MARK,
  );
  return hit?.name ? { name: hit.name, ...(hit.args?.v ? { v: hit.args.v } : {}) } : null;
}

const ASK_IDS: readonly string[] = ["E3", "E3-n", "E3-r"];

/**
 * El texto de la pregunta que contesta este «Sí» o «No» (E3, E3-n, E3-r o E3-t): el del mensaje
 * al que responde y, si no viene el contexto, la última pregunta que se le mostró. null si nunca
 * se le preguntó (un toque sin pregunta no enciende nada).
 */
async function askedText(tx: Tx, c: PrefCtx): Promise<(ReengageAskId | "E3-t") | null> {
  const replied = await repliedMark(tx, c.phoneId, c.replyTo);
  if (replied?.name === REASK_TEMPLATE_MARK) return "E3-t";
  if (replied?.name === REENGAGE_ASK_MARK && ASK_IDS.includes(replied.v ?? ""))
    return replied.v as ReengageAskId;
  const m = schema.message;
  const [last] = await tx
    .select({ toolCalls: m.toolCalls })
    .from(m)
    .where(
      and(
        eq(m.phoneId, c.phoneId),
        eq(m.direction, "out"),
        sql`(${m.toolCalls} @> ${JSON.stringify([{ name: REENGAGE_ASK_MARK }])}::jsonb
             or ${m.toolCalls} @> ${JSON.stringify([{ name: REASK_TEMPLATE_MARK }])}::jsonb)`,
      ),
    )
    .orderBy(desc(m.createdAt))
    .limit(1);
  const calls = (Array.isArray(last?.toolCalls) ? last.toolCalls : []) as MarkCall[];
  if (calls.some((x) => x.name === REASK_TEMPLATE_MARK)) return "E3-t";
  const v = calls.find((x) => x.name === REENGAGE_ASK_MARK)?.args?.v ?? "";
  return ASK_IDS.includes(v) ? (v as ReengageAskId) : null;
}

/** El más amplio de dos apagados pendientes: «no me escribas» incluye «no me recuerdes». */
const wider = (
  a: PrefState["prefPending"],
  b: "nudges_off" | "all_off",
): "nudges_off" | "all_off" => (a === "all_off" || b === "all_off" ? "all_off" : "nudges_off");

function card(target: "nudges_off" | "all_off", s: PrefState, reengage = false): Outbound {
  return target === "all_off"
    ? es.prefAllOffCard(reengage)
    : es.prefNudgesOffCard(!s.nudgeOptInAt, reengage);
}

/** Muestra la tarjeta y deja el apagado pendiente (D10): desde ya no se manda lo que apagaría. */
async function ask(
  tx: Tx,
  c: PrefCtx,
  s: PrefState,
  target: "nudges_off" | "all_off",
  reengage = false,
): Promise<PrefResult> {
  if (s.tagged || s.unsolicitedOffAt) return reply(es.prefAlreadyOff("all_off"));
  if (target === "nudges_off" && s.nudgeOffAt) return reply(es.prefAlreadyOff("nudges_off"));
  const pending = wider(s.prefPending, target);
  await setPhone(tx, c.phoneId, { prefPending: pending, prefPendingAt: c.now });
  return reply(card(target, s, reengage), [{ name: "pref_confirm", args: { target } }]);
}

/**
 * Apagar también apaga E1 (agencia §3.2–§3.3): «actívame los avisos» vuelve a encender el mensaje
 * de la noche, no la plantilla, que pide otro «Sí». Se audita con el texto del apagado.
 */
async function dropReengage(
  tx: Tx,
  c: PrefCtx,
  s: PrefState,
  textId: ConsentTextId,
  reengage: boolean,
  source: "word" | "button" = "button",
): Promise<void> {
  if (!s.reengageOptInAt) return;
  await setPhone(tx, c.phoneId, { reengageOptInAt: null });
  await audit(tx, c, "reengage_off", textId, source, reengage);
}

async function confirm(
  tx: Tx,
  c: PrefCtx,
  s: PrefState,
  target: "nudges_off" | "all_off",
  reengage = false,
): Promise<PrefResult> {
  if (target === "all_off") {
    if (s.unsolicitedOffAt || s.tagged) return reply(es.prefAlreadyOff("all_off"));
    // «No me escribas» de una plantilla (E1 o E3-t): apaga sin tarjeta y guarda ese texto.
    const replied = await repliedMark(tx, c.phoneId, c.replyTo);
    const textId: ConsentTextId =
      replied?.name === REENGAGE_TEMPLATE_MARK
        ? "E1-A"
        : replied?.name === REASK_TEMPLATE_MARK
          ? "E3-t"
          : "H46";
    await setPhone(tx, c.phoneId, {
      unsolicitedOffAt: c.now,
      prefPending: null,
      prefPendingAt: null,
    });
    await audit(tx, c, "all_off", textId, "button", reengage);
    await dropReengage(tx, c, s, textId, reengage);
    return reply(es.prefAllOffDone());
  }
  if (s.nudgeOffAt) return reply(es.prefAlreadyOff("nudges_off"));
  const neverOptedIn = !s.nudgeOptInAt;
  // El «Sí» de H45 quita lo pendiente solo si era igual (un «no me escribas» pendiente sigue).
  await setPhone(tx, c.phoneId, {
    nudgeOffAt: c.now,
    ...(s.prefPending === "nudges_off" ? { prefPending: null, prefPendingAt: null } : {}),
  });
  const id45 = neverOptedIn ? "H45-n" : "H45";
  await audit(tx, c, "nudge_off", id45, "button", reengage);
  await dropReengage(tx, c, s, id45, reengage);
  return reply(es.prefNudgesOffDone(neverOptedIn, reengage));
}

async function keep(
  tx: Tx,
  c: PrefCtx,
  s: PrefState,
  target: "nudges_off" | "all_off",
  reengage = false,
): Promise<PrefResult> {
  const marks = [{ name: "pref_kept", args: { target } }];
  // Un «No» en una H45 vieja no quita un «no me escribas» pendiente: se vuelve a mostrar H46.
  if (s.prefPending === "all_off" && target === "nudges_off")
    return reply(es.prefAllOffCard(reengage), marks);
  if (s.prefPending === target)
    await setPhone(tx, c.phoneId, { prefPending: null, prefPendingAt: null });
  return reply(es.prefKept(), marks);
}

async function turnOn(
  tx: Tx,
  c: PrefCtx,
  s: PrefState,
  intent: "nudges_on" | "all_on" | "both_on",
  source: "word" | "button",
  /** DC-13: con el mensaje de las 8 pm para todos, el texto que dice que también llega el cierre. */
  daily = false,
): Promise<PrefResult> {
  if (s.tagged) return reply(es.prefTagged(c.privacyContact));
  const paused = s.nudgePausedUntil !== null && s.nudgePausedUntil.getTime() > c.now.getTime();
  const clearPending = { prefPending: null, prefPendingAt: null };
  // «avísame a las 8» con «no me escribas» puesto: si no, la puerta igual lo negaría (nota 14).
  const effective = intent === "nudges_on" && s.unsolicitedOffAt ? "both_on" : intent;
  if (effective === "all_on") {
    if (!s.unsolicitedOffAt && !s.prefPending) return reply(es.prefAlreadyOn());
    await setPhone(tx, c.phoneId, { unsolicitedOffAt: null, ...clearPending });
    if (s.unsolicitedOffAt) await audit(tx, c, "all_on", "H13b", source);
    return reply(es.prefTurnedOn("H13b", c.held));
  }
  const nudgeOn = s.nudgeOptInAt && !s.nudgeOffAt && !paused;
  if (effective === "nudges_on") {
    if (nudgeOn && !s.prefPending) return reply(es.prefAlreadyOn());
    await setPhone(tx, c.phoneId, {
      nudgeOptInAt: c.now,
      nudgeOffAt: null,
      nudgePausedUntil: null,
      ...clearPending,
    });
    const id13 = daily ? "H13-daily" : "H13";
    await audit(tx, c, "nudge_opt_in", id13, source);
    return reply(es.prefTurnedOn(id13, c.held));
  }
  if (nudgeOn && !s.unsolicitedOffAt && !s.prefPending) return reply(es.prefAlreadyOn());
  const wasAllOff = s.unsolicitedOffAt !== null;
  const id = wasAllOff ? "H13c-all" : "H13c";
  await setPhone(tx, c.phoneId, {
    nudgeOptInAt: c.now,
    nudgeOffAt: null,
    unsolicitedOffAt: null,
    nudgePausedUntil: null,
    ...clearPending,
  });
  await audit(tx, c, "nudge_opt_in", id, source);
  if (wasAllOff) await audit(tx, c, "all_on", id, source);
  return reply(es.prefTurnedOn(id, c.held));
}

/**
 * H8 «Avísame a las 8» de la oferta en la tarjeta (US-206), o «Sí, escríbeme» del primer mensaje
 * de las 8 pm (1B, H7d, con `dailyClose`): enciende solo el aviso, con ese texto como el visto, y
 * responde con una ✅ sobre el toque (sin texto). Con todo apagado por «no me escribas», el botón
 * no lo enciende: se explica igual que a la frase. `s` es el estado real (sin `withDefaultNudge`).
 */
async function optIn(
  tx: Tx,
  c: PrefCtx,
  s: PrefState,
  textId: "H7" | "H7d",
  reengage = false,
): Promise<PrefResult> {
  if (s.tagged) return reply(es.prefTagged(c.privacyContact));
  if (s.unsolicitedOffAt) return reply(es.prefAlreadyOff("all_off"));
  // Un «no me escribas» sin contestar sigue abierto: se vuelve a mostrar esa tarjeta.
  if (s.prefPending === "all_off") return reply(es.prefAllOffCard(reengage));
  const paused = s.nudgePausedUntil !== null && s.nudgePausedUntil.getTime() > c.now.getTime();
  const on = s.nudgeOptInAt && !s.nudgeOffAt && !paused && !s.prefPending;
  if (!on) {
    await setPhone(tx, c.phoneId, {
      nudgeOptInAt: c.now,
      nudgeOffAt: null,
      nudgePausedUntil: null,
      ...(s.prefPending === "nudges_off" ? { prefPending: null, prefPendingAt: null } : {}),
    });
    await audit(tx, c, "nudge_opt_in", textId, "button");
  }
  const marks = [{ name: "habit_optin", args: { source: "button" } }];
  return c.inboundId
    ? { outbound: [{ type: "reaction", body: "✅", waMessageId: c.inboundId }], toolCalls: marks }
    : reply(es.prefTurnedOn("H13", c.held), marks);
}

/**
 * Retención E3 (agencia §3.2, A-0051), sin la IA: «Sí, recuérdame» de la pregunta E3, E3-n o E3-r
 * en una tarjeta, o de la plantilla E3-t. Enciende el mensaje de la noche como `optIn` (y limpia
 * el apagado y la pausa), guarda el consentimiento de la plantilla E1 y la hora habitual, y
 * responde E3-sí. «No, gracias» guarda el no (no se vuelve a preguntar) y responde E3-no. Con
 * «no me escribas» o la etiqueta `no-contactar`, ninguno enciende ni guarda nada: se responde
 * como `optIn`. `s` es el estado real.
 */
async function reengageAnswer(
  tx: Tx,
  c: PrefCtx,
  s: PrefState,
  yes: boolean,
  reengage: boolean,
): Promise<PrefResult | null> {
  if (s.tagged) return reply(es.prefTagged(c.privacyContact));
  if (s.unsolicitedOffAt) return reply(es.prefAlreadyOff("all_off"));
  if (s.prefPending === "all_off") return reply(es.prefAllOffCard(reengage));
  const textId = await askedText(tx, c);
  // Sin una pregunta mostrada no hay texto que auditar: el toque no enciende nada.
  if (!textId) return null;
  const marks = [{ name: yes ? "reengage_yes" : "reengage_no", args: { text_id: textId } }];
  if (!yes) {
    if (!s.reengageDeclinedAt && !s.reengageOptInAt) {
      await setPhone(tx, c.phoneId, { reengageDeclinedAt: c.now });
      await audit(tx, c, "reengage_declined", textId, "button");
    }
    return reply(es.reengageNo(), marks);
  }
  if (s.reengageOptInAt) return reply(es.reengageYes(), marks);
  // «a esta hora»: la hora del primer movimiento (con un día de datos, la hora habitual es esa);
  // E3-n, de noche, dice «a eso de las 7 de la noche».
  const minute = textId === "E3-n" ? USUAL_DEFAULT : await usualMinute(tx, c.tenantId, c.now);
  await setPhone(tx, c.phoneId, {
    nudgeOptInAt: c.now,
    nudgeOffAt: null,
    nudgePausedUntil: null,
    reengageOptInAt: c.now,
    reengageDeclinedAt: null,
    reengageMinute: minute,
    ...(s.prefPending === "nudges_off" ? { prefPending: null, prefPendingAt: null } : {}),
  });
  await audit(tx, c, "nudge_opt_in", textId, "button");
  await audit(tx, c, "reengage_opt_in", textId, "button");
  return reply(es.reengageYes(), marks);
}

function status(c: PrefCtx, s: PrefState, reengage = false): PrefResult {
  // Con una tarjeta sin contestar, se vuelve a mostrar esa tarjeta: la decisión sigue abierta.
  if (s.prefPending) return reply(card(s.prefPending, s, reengage));
  const paused = s.nudgePausedUntil !== null && s.nudgePausedUntil.getTime() > c.now.getTime();
  const state =
    s.unsolicitedOffAt || s.tagged ? "C" : s.nudgeOptInAt && !s.nudgeOffAt && !paused ? "A" : "B";
  return reply(
    es.prefStatus({
      state,
      nudgeOff: s.nudgeOffAt !== null,
      held: c.held,
      ...(reengage ? { reengage } : {}),
    }),
  );
}

/** Lo que el teléfono pidió sobre sus avisos, o null si el mensaje no es de esto. */
export async function routePrefs(
  tx: Tx,
  c: PrefCtx,
  input: { text?: string | null; replyId?: string | null },
): Promise<PrefResult | null> {
  const parsed = input.replyId ? parseReplyId(input.replyId) : null;
  const tap = parsed?.kind === "pref" ? parsed.value : null;
  const intent = input.text ? classifyPref(input.text) : null;
  if (!tap && !intent) return null;
  const flags = await habitSettings(tx);
  if (!flags.prefs) return null;
  const byDefault = nudgeByDefault(flags);
  // Retención E1–E3: los textos de apagar y «mis avisos» con la línea de E1 (agencia §3.3).
  const e1 = flags.reengageAsk;
  // Real para encender; mostrado (con la pregunta de 1B abierta) para tarjetas y estado.
  const real = await prefState(tx, c.phoneId, c.tenantId);
  const s =
    byDefault && !real.nudgeOptInAt
      ? withDefaultNudge(real, await eveningAskOpen(tx, c.phoneId, c.now))
      : real;

  // El aviso de racha y los recordatorios son del dueño (R-2 d). Apagar sí funciona en cualquier
  // teléfono (inofensivo, F2-7).
  if (c.role !== "owner") {
    if (
      intent === "status" ||
      intent === "nudges_on" ||
      intent === "both_on" ||
      tap === "on" ||
      tap === "optin" ||
      tap === "reengage_yes" ||
      tap === "reengage_no"
    )
      return reply(es.prefEmployee(false));
    if (intent === "all_on") {
      if (s.unsolicitedOffAt) {
        await setPhone(tx, c.phoneId, {
          unsolicitedOffAt: null,
          prefPending: null,
          prefPendingAt: null,
        });
        await audit(tx, c, "all_on", "R-2d", "word");
      }
      return reply(es.prefEmployee(true));
    }
  }

  switch (tap ?? intent) {
    case "nudges_off":
    case "all_off":
      return ask(tx, c, s, (tap ?? intent) as "nudges_off" | "all_off", e1);
    case "yes:nudges_off":
      return confirm(tx, c, s, "nudges_off", e1);
    case "yes:all_off":
      return confirm(tx, c, s, "all_off", e1);
    case "keep:nudges_off":
      return keep(tx, c, s, "nudges_off", e1);
    case "keep:all_off":
      return keep(tx, c, s, "all_off", e1);
    case "on":
      return turnOn(tx, c, real, "both_on", "button", byDefault);
    case "optin":
      return optIn(tx, c, real, byDefault ? "H7d" : "H7", e1);
    case "reengage_yes":
    case "reengage_no":
      // Sin el recordatorio a su hora encendido, el toque no hace nada (va como botón viejo).
      if (!reengageOn(flags)) return null;
      return reengageAnswer(tx, c, real, tap === "reengage_yes", e1);
    case "nudges_on":
    case "all_on":
    case "both_on":
      return turnOn(tx, c, real, intent as "nudges_on" | "all_on" | "both_on", "word", byDefault);
    case "status":
      return status(c, s, e1);
    default:
      return null;
  }
}

/** ¿Tiene algo apagado este teléfono? Para la línea del menú (H51b). */
export async function hasPrefsOff(tx: Tx, phoneId: string): Promise<boolean> {
  const [p] = await tx
    .select({ a: schema.phoneNumber.nudgeOffAt, b: schema.phoneNumber.unsolicitedOffAt })
    .from(schema.phoneNumber)
    .where(eq(schema.phoneNumber.id, phoneId));
  return Boolean(p?.a || p?.b);
}

export type DashboardPrefSwitch = "nudge" | "unsolicited";
export type DashboardPrefError = "tagged" | "needs_unsolicited";

/**
 * Los dos interruptores de Ajustes (US-205, H14): el mismo efecto que el chat, sin tarjeta (el
 * diálogo H14e ya pidió la confirmación). Encender limpia la pausa y lo pendiente (R-2 b, D10).
 * La auditoría guarda el texto que vio el dueño: H14-1/H14-2 al encender, H14e-1/H14e-2 al apagar.
 */
export async function setDashboardPref(
  tx: Tx,
  c: { tenantId: string; phoneId: string; userId: string; now: Date },
  which: DashboardPrefSwitch,
  on: boolean,
): Promise<DashboardPrefError | null> {
  const s = await prefState(tx, c.phoneId, c.tenantId);
  if (s.tagged) return "tagged";
  const clearPending = { prefPending: null, prefPendingAt: null };
  let action: ConsentAction;
  let textId: ConsentTextId;
  // Apagar en Ajustes también apaga E1 (como en el chat): volver a encender pide otro «Sí».
  const dropReengageHere = !on && s.reengageOptInAt ? { reengageOptInAt: null } : {};
  if (which === "unsolicited") {
    if (on) {
      await setPhone(tx, c.phoneId, { unsolicitedOffAt: null, ...clearPending });
      [action, textId] = ["all_on", "H14-2"];
    } else {
      await setPhone(tx, c.phoneId, {
        unsolicitedOffAt: s.unsolicitedOffAt ?? c.now,
        ...clearPending,
        ...dropReengageHere,
      });
      [action, textId] = ["all_off", "H14e-2"];
    }
  } else if (on) {
    // R-2 c: el aviso de racha no se enciende con los mensajes por su cuenta apagados.
    if (s.unsolicitedOffAt) return "needs_unsolicited";
    await setPhone(tx, c.phoneId, {
      nudgeOptInAt: c.now,
      nudgeOffAt: null,
      nudgePausedUntil: null,
      ...clearPending,
    });
    [action, textId] = ["nudge_opt_in", "H14-1"];
  } else {
    await setPhone(tx, c.phoneId, {
      nudgeOffAt: s.nudgeOffAt ?? c.now,
      ...(s.prefPending === "nudges_off" ? clearPending : {}),
      ...dropReengageHere,
    });
    [action, textId] = ["nudge_off", "H14e-1"];
  }
  await tx.insert(schema.auditLog).values({
    tenantId: c.tenantId,
    actorType: "user",
    actorId: c.userId,
    action,
    entity: "phone_number",
    entityId: c.phoneId,
    after: { source: "dashboard", text_id: textId, text_version: consentTextVersion[textId] },
    channel: "dashboard",
  });
  if ("reengageOptInAt" in dropReengageHere)
    await tx.insert(schema.auditLog).values({
      tenantId: c.tenantId,
      actorType: "user",
      actorId: c.userId,
      action: "reengage_off",
      entity: "phone_number",
      entityId: c.phoneId,
      after: { source: "dashboard", text_id: textId, text_version: consentTextVersion[textId] },
      channel: "dashboard",
    });
  return null;
}
