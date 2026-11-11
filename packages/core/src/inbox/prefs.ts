import { and, eq, inArray, schema, sql, type Tx } from "@caja/db";
import { habitSettings, nudgeByDefault } from "../ledger/habits";
import { type ConsentTextId, consentTextVersion } from "../render/es-VE";
import { es, type Outbound, parseReplyId } from "../render/index";

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
}>;

async function setPhone(tx: Tx, phoneId: string, change: PhoneChange): Promise<void> {
  await tx.update(schema.phoneNumber).set(change).where(eq(schema.phoneNumber.id, phoneId));
}

type ConsentAction = "nudge_opt_in" | "nudge_off" | "all_off" | "all_on";

/** Consentimiento (US-201, F2-4): qué texto vio y su versión. Nunca lo que escribió. */
async function audit(
  tx: Tx,
  c: PrefCtx,
  action: ConsentAction,
  textId: ConsentTextId,
  source: "word" | "button",
): Promise<void> {
  await tx.insert(schema.auditLog).values({
    tenantId: c.tenantId,
    actorType: "phone",
    actorId: c.phoneId,
    action,
    entity: "phone_number",
    entityId: c.phoneId,
    after: { source, text_id: textId, text_version: consentTextVersion[textId] },
    channel: "whatsapp",
  });
}

/** El más amplio de dos apagados pendientes: «no me escribas» incluye «no me recuerdes». */
const wider = (
  a: PrefState["prefPending"],
  b: "nudges_off" | "all_off",
): "nudges_off" | "all_off" => (a === "all_off" || b === "all_off" ? "all_off" : "nudges_off");

function card(target: "nudges_off" | "all_off", s: PrefState): Outbound {
  return target === "all_off" ? es.prefAllOffCard() : es.prefNudgesOffCard(!s.nudgeOptInAt);
}

/** Muestra la tarjeta y deja el apagado pendiente (D10): desde ya no se manda lo que apagaría. */
async function ask(
  tx: Tx,
  c: PrefCtx,
  s: PrefState,
  target: "nudges_off" | "all_off",
): Promise<PrefResult> {
  if (s.tagged || s.unsolicitedOffAt) return reply(es.prefAlreadyOff("all_off"));
  if (target === "nudges_off" && s.nudgeOffAt) return reply(es.prefAlreadyOff("nudges_off"));
  const pending = wider(s.prefPending, target);
  await setPhone(tx, c.phoneId, { prefPending: pending, prefPendingAt: c.now });
  return reply(card(target, s), [{ name: "pref_confirm", args: { target } }]);
}

async function confirm(
  tx: Tx,
  c: PrefCtx,
  s: PrefState,
  target: "nudges_off" | "all_off",
): Promise<PrefResult> {
  if (target === "all_off") {
    if (s.unsolicitedOffAt || s.tagged) return reply(es.prefAlreadyOff("all_off"));
    await setPhone(tx, c.phoneId, {
      unsolicitedOffAt: c.now,
      prefPending: null,
      prefPendingAt: null,
    });
    await audit(tx, c, "all_off", "H46", "button");
    return reply(es.prefAllOffDone());
  }
  if (s.nudgeOffAt) return reply(es.prefAlreadyOff("nudges_off"));
  const neverOptedIn = !s.nudgeOptInAt;
  // El «Sí» de H45 quita lo pendiente solo si era igual (un «no me escribas» pendiente sigue).
  await setPhone(tx, c.phoneId, {
    nudgeOffAt: c.now,
    ...(s.prefPending === "nudges_off" ? { prefPending: null, prefPendingAt: null } : {}),
  });
  await audit(tx, c, "nudge_off", neverOptedIn ? "H45-n" : "H45", "button");
  return reply(es.prefNudgesOffDone(neverOptedIn));
}

async function keep(
  tx: Tx,
  c: PrefCtx,
  s: PrefState,
  target: "nudges_off" | "all_off",
): Promise<PrefResult> {
  const marks = [{ name: "pref_kept", args: { target } }];
  // Un «No» en una H45 vieja no quita un «no me escribas» pendiente: se vuelve a mostrar H46.
  if (s.prefPending === "all_off" && target === "nudges_off")
    return reply(es.prefAllOffCard(), marks);
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
async function optIn(tx: Tx, c: PrefCtx, s: PrefState, textId: "H7" | "H7d"): Promise<PrefResult> {
  if (s.tagged) return reply(es.prefTagged(c.privacyContact));
  if (s.unsolicitedOffAt) return reply(es.prefAlreadyOff("all_off"));
  // Un «no me escribas» sin contestar sigue abierto: se vuelve a mostrar esa tarjeta.
  if (s.prefPending === "all_off") return reply(es.prefAllOffCard());
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

function status(c: PrefCtx, s: PrefState): PrefResult {
  // Con una tarjeta sin contestar, se vuelve a mostrar esa tarjeta: la decisión sigue abierta.
  if (s.prefPending) return reply(card(s.prefPending, s));
  const paused = s.nudgePausedUntil !== null && s.nudgePausedUntil.getTime() > c.now.getTime();
  const state =
    s.unsolicitedOffAt || s.tagged ? "C" : s.nudgeOptInAt && !s.nudgeOffAt && !paused ? "A" : "B";
  return reply(es.prefStatus({ state, nudgeOff: s.nudgeOffAt !== null, held: c.held }));
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
      tap === "optin"
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
      return ask(tx, c, s, (tap ?? intent) as "nudges_off" | "all_off");
    case "yes:nudges_off":
      return confirm(tx, c, s, "nudges_off");
    case "yes:all_off":
      return confirm(tx, c, s, "all_off");
    case "keep:nudges_off":
      return keep(tx, c, s, "nudges_off");
    case "keep:all_off":
      return keep(tx, c, s, "all_off");
    case "on":
      return turnOn(tx, c, real, "both_on", "button", byDefault);
    case "optin":
      return optIn(tx, c, real, byDefault ? "H7d" : "H7");
    case "nudges_on":
    case "all_on":
    case "both_on":
      return turnOn(tx, c, real, intent as "nudges_on" | "all_on" | "both_on", "word", byDefault);
    case "status":
      return status(c, s);
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
  if (which === "unsolicited") {
    if (on) {
      await setPhone(tx, c.phoneId, { unsolicitedOffAt: null, ...clearPending });
      [action, textId] = ["all_on", "H14-2"];
    } else {
      await setPhone(tx, c.phoneId, {
        unsolicitedOffAt: s.unsolicitedOffAt ?? c.now,
        ...clearPending,
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
  return null;
}
