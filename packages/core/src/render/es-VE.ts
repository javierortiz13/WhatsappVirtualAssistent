import { asIsoDate, formatShortDate, type IsoDate, monthNameEs } from "../domain/dates";
import { Decimal, formatMoney, parseVenezuelanAmount, type RateOrigin } from "../domain/money";
import type { PagoMovilData } from "../domain/pago-movil";
import { IDS, type Outbound, type RenewMethod } from "./outbound";

/**
 * Todo texto que ve el usuario vive aquí (Fase 4). Español venezolano, tuteo, corto, un emoji
 * funcional como máximo. Las cifras llegan ya calculadas por el backend; aquí solo se formatean.
 */

export type RateInfo = {
  current: { value: Decimal; effectiveDate: IsoDate } | null;
  next: { value: Decimal; effectiveDate: IsoDate } | null;
  /** La vigente tiene más de 3 días hábiles: puede estar desactualizada. */
  stale: boolean;
};

const MENU_BUTTONS = [
  { id: IDS.menuExpense, title: "Registrar gasto" },
  { id: IDS.menuIncome, title: "Registrar venta" },
  { id: IDS.menuClose, title: "Ver cierre" },
];

export function rateLine(r: RateInfo): string {
  if (!r.current) return "Tasa BCV: no disponible por ahora";
  const base = `Tasa BCV hoy: *${formatMoney(r.current.value, "VES")}* (vigente ${formatShortDate(r.current.effectiveDate)})`;
  return r.stale ? `${base} ⚠️ puede estar desactualizada` : base;
}

export function menu(r: RateInfo): Outbound {
  return { type: "buttons", body: `${rateLine(r)}\n¿Qué quieres hacer?`, buttons: MENU_BUTTONS };
}

export function welcomeOwner(tenantName: string, assistantName: string, r: RateInfo): Outbound {
  return {
    type: "buttons",
    body:
      `✅ Listo, tu número quedó vinculado a *${tenantName}*.\n\n` +
      `Soy *${assistantName}*, un asistente automático. Me escribes como le escribirías a tu cajera:\n` +
      "• _gasté 15$ en champú_\n" +
      "• _hoy vendí 350$: 200 efectivo, 100 pago móvil, 50 punto_\n" +
      "• _cómo va el mes_\n\n" +
      "También me puedes mandar una nota de voz o la factura en foto o PDF.\n\n" +
      rateLine(r),
    buttons: MENU_BUTTONS,
  };
}

export function welcomeEmployee(displayName: string | null, tenantName: string): Outbound {
  const hi = displayName ? `Hola, ${displayName}.` : "Hola.";
  return {
    type: "text",
    body:
      `${hi} Quedaste registrado como empleado de *${tenantName}*. Puedes registrar gastos y ventas; los cierres los ve el dueño.\n` +
      "Ejemplo: _gasté 5$ en hielo_",
  };
}

export function rate(r: RateInfo): Outbound {
  if (!r.current) {
    return {
      type: "text",
      body: "No tengo la tasa BCV cargada todavía. Inténtalo más tarde o revisa bcv.org.ve.",
    };
  }
  const lines = [
    "💵 Tasa BCV",
    `Vigente hoy (${formatShortDate(r.current.effectiveDate)}): *${formatMoney(r.current.value, "VES")}*`,
  ];
  if (r.next)
    lines.push(
      `Próxima (${formatShortDate(r.next.effectiveDate)}): *${formatMoney(r.next.value, "VES")}*`,
    );
  if (r.stale) {
    lines.push(
      `⚠️ Esta tasa es del ${formatShortDate(r.current.effectiveDate)}; no he podido actualizarla. Verifica en bcv.org.ve antes de usarla.`,
    );
  }
  return { type: "text", body: lines.join("\n") };
}

export function help(dashboardUrl: string, supportHint: string | null): Outbound {
  const lines = [
    "Esto es lo que puedo hacer:",
    "• Registrar gastos: _gasté 15$ en champú_, o nota de voz, o la factura en foto o PDF",
    "• Registrar ventas: _hoy vendí 350$: 200 efectivo, 150 pago móvil_",
    "• Cierre: _cierre de hoy_, _cómo va el mes_, _cuánto gasté en insumos esta semana_",
    "• Tasa: _tasa_",
    "• Calculadora: _cuánto es 8000 bs en $_, _17€ en bs_",
    "• Pago móvil: mándame la foto de los datos y te los paso listos para copiar en el banco",
    "• Cambios USDT: _cambié 100 usdt a 970_ y tus gastos en Bs salen a esa tasa",
    `Para ver, corregir o exportar todo: ${dashboardUrl}`,
  ];
  if (supportHint) lines.push(`Si algo no funciona, escribe a una persona: ${supportHint}`);
  return { type: "text", body: lines.join("\n") };
}

/** "link del dashboard" (03/10): el enlace y cómo entrar. El empleado no tiene dashboard. */
export function dashboardLink(dashboardUrl: string, role: "owner" | "employee"): Outbound {
  if (role === "employee")
    return {
      type: "text",
      body: "El dashboard lo ve el dueño del negocio. Tú puedes registrar gastos y ventas por aquí.",
    };
  return {
    type: "text",
    body: [
      `📊 Tu dashboard: ${dashboardUrl}`,
      "Ahí ves, corriges y exportas todos tus movimientos, y pones presupuestos por categoría.",
      "Para entrar escribe tu correo: te mandamos un enlace y entras con un toque.",
    ].join("\n"),
  };
}

export function unknownNumber(registerUrl: string): Outbound {
  return {
    type: "text",
    body: `Este número no está registrado. Crea tu cuenta aquí: ${registerUrl}`,
  };
}

/** Conocido que pasó el límite de mensajes: un solo aviso, luego silencio hasta que venza la ventana. */
export function tooFast(): Outbound {
  return {
    type: "text",
    body: "Me llegaron muchos mensajes seguidos. Espera unos minutos y me escribes de nuevo.",
  };
}

/** Número del dueño todavía sin verificar: solo acepta el código del dashboard. */
/** Negocio suspendido por plan vencido: sin LLM, con el contacto para renovar. Los datos siguen. */
export function planExpired(supportHint: string | null): Outbound {
  const contact = supportHint ? ` Si necesitas ayuda: ${supportHint}` : "";
  return {
    type: "text",
    body: `Tu plan del asistente venció y por ahora no puedo registrar nada. Tus datos siguen guardados. Para renovarlo escribe *renovar* y te digo cómo pagar.${contact}`,
  };
}

// ---------------------------------------------------------------- renovar el plan (03/10)

const RENEW_METHOD_LABELS: Record<RenewMethod, string> = {
  pago_movil: "Pago móvil",
  zelle: "Zelle",
  binance: "Binance",
};

export type RenewQuoteView = {
  method: RenewMethod;
  currency: "VES" | "USD" | "USDT";
  amount: Decimal.Value;
  rateKind: "bcv_usd" | "bcv_eur" | null;
  rateValue: Decimal.Value | null;
};

/** "*Bs 19.468,72* (tasa euro 973,93)", "*$19,99*", "*19,99 USDT*". */
function renewAmount(q: RenewQuoteView): string {
  if (q.currency === "USDT") return `*${formatMoney(q.amount, "USD").replace("$", "")} USDT*`;
  if (q.currency === "USD") return `*${formatMoney(q.amount, "USD")}*`;
  const rate = q.rateValue
    ? ` (tasa ${q.rateKind === "bcv_eur" ? "euro" : "BCV"} ${formatMoney(q.rateValue, "VES").replace("Bs ", "")})`
    : "";
  return `*${formatMoney(q.amount, "VES")}*${rate}`;
}

const monthsText = (n: number) => (n === 1 ? "1 mes" : `${n} meses`);

export type RenewOfferView = {
  planName: string;
  planId: string;
  /** Si pidió cambiarse de plan, el nombre del actual. */
  fromPlanName: string | null;
  stateKind: "trial" | "active" | "grace" | "expired" | "suspended";
  endsAt: IsoDate | null;
  daysLeft: number | null;
  months: number;
  quotes: RenewQuoteView[];
  supportHint: string | null;
};

function renewStateLine(v: RenewOfferView): string {
  const when = v.endsAt ? formatShortDate(v.endsAt) : null;
  const left =
    v.daysLeft !== null && v.daysLeft > 0
      ? ` (${v.daysLeft === 1 ? "falta 1 día" : `faltan ${v.daysLeft} días`})`
      : "";
  switch (v.stateKind) {
    case "trial":
      return when ? `Tu prueba gratis termina el ${when}${left}.` : "Estás en la prueba gratis.";
    case "active":
      return when ? `Vence el ${when}${left}.` : "Tu plan está activo.";
    case "grace":
      return when
        ? `Venció el ${when}; tienes 3 días de gracia antes de que se suspenda.`
        : "Tu plan venció.";
    default:
      return when ? `Venció el ${when} y está suspendido.` : "Tu plan está suspendido.";
  }
}

/** Plan, vencimiento y cuánto cuesta renovar por cada método, con un botón por método. */
export function renewOffer(v: RenewOfferView): Outbound {
  const head = v.fromPlanName
    ? `*Cambiar a ${v.planName}* (hoy tienes ${v.fromPlanName})`
    : `*Tu plan: ${v.planName}*`;
  const lines = [head, renewStateLine(v)];
  if (v.quotes.length === 0) {
    lines.push(
      v.supportHint
        ? `Para renovar escríbenos: ${v.supportHint}`
        : "Para renovar escríbele a quien te dio de alta.",
    );
    return { type: "text", body: lines.join("\n") };
  }
  lines.push(`Renovar ${monthsText(v.months)}:`);
  for (const q of v.quotes) lines.push(`• ${RENEW_METHOD_LABELS[q.method]}: ${renewAmount(q)}`);
  lines.push("¿Cómo vas a pagar?");
  return {
    type: "buttons",
    body: lines.join("\n"),
    buttons: v.quotes.map((q) => ({
      id: IDS.renew(q.method, v.planId, v.months),
      title: RENEW_METHOD_LABELS[q.method],
    })),
  };
}

/** Datos para pagar por el método elegido y qué mandar después. */
export function renewPayTo(v: {
  quote: RenewQuoteView;
  dest: string;
  planName: string;
  months: number;
}): Outbound {
  return {
    type: "text",
    body: [
      `*${RENEW_METHOD_LABELS[v.quote.method]}* · Plan ${v.planName}, ${monthsText(v.months)}`,
      `Monto: ${renewAmount(v.quote)}`,
      `Datos: ${v.dest}`,
      "Cuando pagues, mándame la referencia. Ejemplo: _ref 123456_",
    ].join("\n"),
  };
}

export function renewReported(v: {
  quote: RenewQuoteView;
  planName: string;
  months: number;
  reference: string;
}): Outbound {
  return {
    type: "text",
    body: `✅ Recibí tu pago: Plan ${v.planName}, ${monthsText(v.months)}, ${renewAmount(v.quote)}, ref ${v.reference}. Lo verificamos y te aviso por aquí.`,
  };
}

/** Mandó la referencia sin haber elegido método: un botón por método reporta de una vez. */
export function renewWhichMethod(reference: string, methods: RenewMethod[]): Outbound {
  return {
    type: "buttons",
    body: `Recibí la referencia ${reference}. ¿Por dónde pagaste?`,
    buttons: methods.map((m) => ({
      id: IDS.renewRef(m, reference),
      title: RENEW_METHOD_LABELS[m],
    })),
  };
}

export function renewTooMany(supportHint: string | null): Outbound {
  return {
    type: "text",
    body: `Ya tienes 3 pagos por verificar. Espera a que los revisemos${supportHint ? ` o escríbenos: ${supportHint}` : "."}`,
  };
}

export function replaceOwnerOnly(): Outbound {
  return {
    type: "text",
    body: "Reemplazar la venta del día lo hace el dueño. Puedes tocar *Agregar* o *Cancelar*.",
  };
}

export function renewOwnerOnly(): Outbound {
  return { type: "text", body: "El plan lo renueva el dueño del negocio." };
}

export function renewUnavailable(supportHint: string | null): Outbound {
  return {
    type: "text",
    body: `No pude calcular el monto ahora mismo. Inténtalo en unos minutos${supportHint ? ` o escríbenos: ${supportHint}` : "."}`,
  };
}

export function paymentVerified(planName: string, paidUntil: IsoDate | null): Outbound {
  return {
    type: "text",
    body: `✅ Pago verificado. Tu plan ${planName} quedó activo${paidUntil ? ` hasta el ${formatShortDate(paidUntil)}` : ""}. ¡Gracias!`,
  };
}

export function paymentRejected(v: {
  reference: string | null;
  reason: string | null;
  supportHint: string | null;
}): Outbound {
  const ref = v.reference ? ` con referencia ${v.reference}` : "";
  const why = v.reason ? ` Motivo: ${v.reason}.` : "";
  const help = v.supportHint ? ` Si crees que es un error, escríbenos: ${v.supportHint}` : "";
  return {
    type: "text",
    body: `No pudimos verificar tu pago${ref}.${why} Revisa los datos y vuelve a mandarme la referencia.${help}`,
  };
}

export function askCode(registerUrl: string): Outbound {
  return {
    type: "text",
    body: `Para activar este número, envíame el código de 6 dígitos que ves en ${registerUrl}`,
  };
}

/** Código incorrecto. No dice a qué negocio pertenece el número. */
export function codeMismatch(): Outbound {
  return {
    type: "text",
    body: "Ese código no coincide. Revisa el que muestra la pantalla de vinculación y envíamelo de nuevo.",
  };
}

export function codeExpired(registerUrl: string): Outbound {
  return {
    type: "text",
    body: `Ese código ya venció o se agotaron los intentos. Genera otro en ${registerUrl} y envíamelo.`,
  };
}

export function outOfScope(): Outbound {
  return {
    type: "buttons",
    body: "Solo te ayudo con tu caja: registrar gastos, registrar ventas y ver el cierre. ¿Qué quieres hacer?",
    buttons: MENU_BUTTONS,
  };
}

/** Ventas, cierres y consultas existen en el menú pero llegan en S3: se dice claro y se ofrece el gasto. */
export function comingSoon(): Outbound {
  return {
    type: "text",
    body: "Eso todavía no lo hago por chat. Lo que sí: _gasté 15$ en champú_ · _hoy vendí 350$: 200 efectivo, 150 pago móvil_ · _cierre_ · _cómo va el mes_ · _no, eran 25_ · _bórralo_",
  };
}

export function ownerOnly(): Outbound {
  return { type: "text", body: "El cierre lo ve el dueño. Tú puedes registrar gastos y ventas." };
}

export function promptExpense(): Outbound {
  return {
    type: "text",
    body: "Dime el gasto. Ejemplo: _gasté 15$ en champú_ o mándame la factura en foto o PDF.",
  };
}

export function promptIncome(): Outbound {
  return {
    type: "text",
    body: "Dime la venta del día. Ejemplo: _hoy vendí 350$: 200 efectivo, 100 pago móvil, 50 punto_",
  };
}

export function promptFix(): Outbound {
  return {
    type: "text",
    body: "Dime qué cambio. Ejemplo: _eran 25_, _es mantenimiento_, _fue el sábado_.",
  };
}

export function confirmationExpired(): Outbound {
  return { type: "text", body: "Esa confirmación ya venció. Mándame el gasto de nuevo." };
}

/** Descartar un borrador: reacción sobre el toque de "Cancelar". Gratis y suficiente como acuse. */
export function cancelled(inboundId: string): Outbound {
  return { type: "reaction", body: "🗑️", waMessageId: inboundId };
}

export function llmDown(): Outbound {
  return { type: "text", body: "Ahora mismo no puedo procesar esto. Inténtalo en unos minutos." };
}

export function mediaNotYet(kind: "audio" | "image"): Outbound {
  return {
    type: "text",
    body:
      kind === "audio"
        ? "Las notas de voz llegan pronto. Por ahora escríbeme el gasto: _gasté 15$ en champú_"
        : "Las fotos de facturas llegan pronto. Por ahora escríbeme el gasto: _gasté 15$ en champú_",
  };
}

// ---------------------------------------------------------------- notas de voz (US-B5)

/** Acuse inmediato de la nota de voz: una reacción, gratis (ADR-014), mientras se transcribe. */
export function audioAck(inboundId: string): Outbound {
  return { type: "reaction", body: "🎧", waMessageId: inboundId };
}

/** La transcripción entre comillas; va en el mismo envío que el borrador o la pregunta. */
export function transcript(text: string): Outbound {
  return { type: "text", body: `🎤 "${text.length > 300 ? `${text.slice(0, 297)}…` : text}"` };
}

export function audioTooLong(): Outbound {
  return {
    type: "text",
    body: "Solo proceso notas de voz cortas, de menos de 2 minutos. ¿Me la repites más corta?",
  };
}

export function audioUnclear(): Outbound {
  return { type: "text", body: "No pude escuchar bien la nota de voz. ¿Me lo escribes?" };
}

// ---------------------------------------------------------------- fotos de facturas (US-B6)

export function imageAck(inboundId: string): Outbound {
  return { type: "reaction", body: "🧾", waMessageId: inboundId };
}

/** Qué leyó el sistema en la foto o el PDF; va en el mismo envío que el borrador. */
export function receiptRead(r: {
  vendor: string;
  date: string;
  total: string;
  currency: string;
  document_type?: "expense" | "sales" | "pago_movil" | "usdt_exchange" | "unknown";
  isPdf?: boolean;
}): Outbound {
  const parts = [r.vendor || "proveedor no legible"];
  if (r.total) parts.push(`${r.total} ${r.currency === "unknown" ? "" : r.currency}`.trim());
  if (r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) parts.push(formatShortDate(asIsoDate(r.date)));
  const what = r.document_type === "sales" ? "el reporte de ventas" : "la factura";
  return { type: "text", body: `🧾 Leí ${what}: ${parts.join(" · ")}` };
}

/**
 * Factura que no se pudo leer (03/10): en un solo mensaje se pide todo lo que falta (gasto o
 * venta, monto con moneda y en qué fue) para que la respuesta siguiente ya sea el borrador. Con
 * `keptPhoto`, el borrador de esa respuesta lleva la foto. `guess` es el total que se alcanzó a
 * ver, para que el usuario lo confirme.
 */
export function receiptUnclear(
  opts: { keptPhoto?: boolean; guess?: { total: string; currency: string } | null } = {},
): Outbound {
  let seen = "";
  const total = opts.guess ? parseLooseAmount(opts.guess.total) : null;
  if (total && opts.guess) {
    const c = opts.guess.currency;
    seen =
      c === "USD" || c === "VES"
        ? ` Me pareció ver un total de *${formatMoney(total, c)}*, pero no estoy seguro.`
        : ` Me pareció ver un total de *${total.toFixed(2).replace(".", ",")}*, pero no estoy seguro.`;
  }
  const keep = opts.keptPhoto ? " y la guardo con la foto" : "";
  return {
    type: "text",
    body: [
      `🧾 No pude leer bien la factura.${seen}`,
      `Escríbeme en *un solo mensaje*: si fue *gasto* o *venta*, el *monto con la moneda* y *en qué fue*${keep}.`,
      "Ejemplo: _gasto 12.955 Bs en comida_",
    ].join("\n"),
  };
}

/** Total leído por el lector ("12955.10" o "12.955,10"); null si no es un monto positivo. */
function parseLooseAmount(s: string): Decimal | null {
  const t = s.trim();
  const d = /^\d+(\.\d+)?$/.test(t) ? new Decimal(t) : parseVenezuelanAmount(t);
  return d?.gt(0) ? d : null;
}

/**
 * Datos de pago móvil de una foto (03/10): un resumen y después cada dato solo en su mensaje,
 * para copiarlo con un toque y pegarlo en el banco. El monto va en bolívares sin puntos de mil.
 */
export function pagoMovil(
  d: PagoMovilData,
  amount: { ves: Decimal; usd: Decimal | null; rate: Decimal | null } | null,
): Outbound[] {
  const lines = ["📲 *Pago móvil*"];
  const bank = [d.bankCode, d.bankName].filter(Boolean).join(" · ");
  if (bank) lines.push(`Banco: ${bank}`);
  if (d.phone) lines.push(`Teléfono: ${d.phone.slice(0, 4)}-${d.phone.slice(4)}`);
  if (d.idNumber) lines.push(`Cédula/RIF: ${d.idLetter ?? "V"}-${d.idNumber}`);
  if (d.holder) lines.push(`Titular: ${d.holder}`);
  if (amount) {
    const usd =
      amount.usd && amount.rate
        ? ` (${formatMoney(amount.usd, "USD")} a tasa BCV ${formatMoney(amount.rate, "VES").replace("Bs ", "")})`
        : "";
    lines.push(`Monto: *${formatMoney(amount.ves, "VES")}*${usd}`);
  }
  lines.push("", "Abajo va cada dato solo para copiarlo y pegarlo en el banco 👇");
  const copies: Outbound[] = [];
  if (d.phone) copies.push({ type: "text", body: d.phone });
  if (d.idNumber) copies.push({ type: "text", body: d.idNumber });
  if (amount) copies.push({ type: "text", body: amount.ves.toFixed(2).replace(".", ",") });
  return [{ type: "text", body: lines.join("\n") }, ...copies];
}

/** Va arriba del borrador de gasto que sigue a los datos de pago móvil. */
export function pagoMovilDraftLead(): Outbound {
  return { type: "text", body: "💸 ¿Es un gasto? Si lo es, toca *Guardar* cuando hagas el pago." };
}

/** Datos de pago móvil sin monto: la respuesta siguiente arma el gasto con la foto. */
export function pagoMovilAskAmount(): Outbound {
  return {
    type: "text",
    body: "💸 ¿Es un gasto? Escríbeme el *monto* y *en qué es* y te lo dejo listo para guardar.\nEjemplo: _1.250 Bs del gas_",
  };
}

export function pagoMovilUnclear(): Outbound {
  return {
    type: "text",
    body: "📲 Parecen datos de pago móvil, pero no pude leer bien el teléfono ni la cédula. Mándame una foto más clara o escríbemelos.",
  };
}

export function notAReceipt(): Outbound {
  return {
    type: "text",
    body: "Solo proceso facturas y recibos, en foto o PDF. Si es un gasto, escríbemelo: _gasté 15$ en champú_",
  };
}

export function imageTooBig(): Outbound {
  return {
    type: "text",
    body: "La foto es muy pesada (más de 5 MB). Mándala de nuevo con menos resolución.",
  };
}

export function unsupported(): Outbound {
  return { type: "text", body: "Solo entiendo texto, notas de voz y facturas en foto o PDF." };
}

export function documentNotSupported(filename: string | null): Outbound {
  const name = filename ? `"${filename}"` : "ese archivo";
  return {
    type: "text",
    body: `No puedo leer ${name}. De archivos solo leo facturas en PDF o en foto. Si es un gasto, escríbemelo: _gasté 15$ en champú_`,
  };
}

export function pdfTooBig(): Outbound {
  return {
    type: "text",
    body: "El PDF es muy pesado (más de 5 MB). Mándame solo la factura o una foto de ella.",
  };
}

export function pdfTooManyPages(pages: number, max: number): Outbound {
  return {
    type: "text",
    body: `Ese PDF tiene ${pages} páginas y leo facturas de hasta ${max}. Mándame solo la factura o una foto del total.`,
  };
}

export function tooLong(): Outbound {
  return { type: "text", body: "Ese mensaje es muy largo. Mándame un gasto o una venta a la vez." };
}

/** Datos ya calculados de un borrador de gasto (payload de `pending_action`). */
export type ExpenseDraftView = {
  pendingId: string;
  amount: Decimal.Value;
  currency: "USD" | "VES";
  currencyInferred: boolean;
  amountUsd: Decimal.Value;
  amountVes: Decimal.Value;
  rateValue: Decimal.Value;
  rateEffectiveDate: string;
  rateSource?: RateOrigin;
  businessDate: string;
  today: IsoDate;
  categoryName: string | null;
  description: string | null;
  transcript: string | null;
  replacedPrevious: boolean;
  /** De los lotes de cambio (0012): saldo después y Bs que no cubrieron. */
  exchange?: { remainingAfter: string; uncoveredVes: string; lastRate: string } | null | undefined;
};

/** "tasa BCV 866,56", "tasa euro 973,93", "tasa manual 850,00" o "tasa de tu cambio 970,00". */
export function rateLabel(value: Decimal.Value, source?: RateOrigin): string {
  const n = formatMoney(value, "VES").replace("Bs ", "");
  if (source === "bcv_eur") return `tasa euro ${n}`;
  if (source === "manual") return `tasa manual ${n}`;
  if (source === "exchange") return `tasa de tu cambio ${n}`;
  return `tasa BCV ${n}`;
}

const rateNum = (v: Decimal.Value) => formatMoney(v, "VES").replace("Bs ", "");

/** Debajo de un borrador de los lotes: cuánto quedará, o qué no alcanzó. */
function exchangeNote(x: {
  remainingAfter: string;
  uncoveredVes: string;
  lastRate: string;
}): string {
  if (new Decimal(x.uncoveredVes).gt(0))
    return `⚠️ Tus cambios no alcanzan: ${formatMoney(x.uncoveredVes, "VES")} van a la tasa de tu último cambio (${rateNum(x.lastRate)}). Si cambiaste de nuevo, dímelo: _cambié 100 usdt a 980_`;
  return `Quedarán ${formatMoney(x.remainingAfter, "VES")} de tus cambios.`;
}

/**
 * Modo "preguntar" (0012): antes del borrador, de dónde salieron los Bs, con los dos cálculos.
 *   💱 ¿De dónde salieron estos *Bs 9.700,00*?
 *   • Mi cambio USDT: *$10,00* (a 970,00)
 *   • Tasa BCV: *$11,19* (866,56)
 */
export function bsRateQuestion(v: {
  pendingId: string;
  description: string | null;
  ves: Decimal.Value;
  exchangeUsd: Decimal.Value;
  exchangeRate: Decimal.Value;
  bcvUsd: Decimal.Value;
  bcvRate: Decimal.Value;
}): Outbound {
  const what = v.description ? ` (${v.description})` : "";
  return {
    type: "buttons",
    body: [
      `💱 ¿De dónde salieron estos *${formatMoney(v.ves, "VES")}*${what}?`,
      `• Mi cambio USDT: *${formatMoney(v.exchangeUsd, "USD")}* (a ${rateNum(v.exchangeRate)})`,
      `• Tasa BCV: *${formatMoney(v.bcvUsd, "USD")}* (${rateNum(v.bcvRate)})`,
    ].join("\n"),
    buttons: [
      { id: IDS.choice(v.pendingId, "usdt"), title: "Mi cambio USDT" },
      { id: IDS.choice(v.pendingId, "bcv"), title: "Tasa BCV" },
      { id: IDS.cancel(v.pendingId), title: "Cancelar" },
    ],
  };
}

/** Borrador de un cambio USDT → Bs. */
export function exchangeDraft(v: {
  pendingId: string;
  usd: Decimal.Value;
  ves: Decimal.Value;
  rate: Decimal.Value;
  businessDate: string;
  today: IsoDate;
}): Outbound {
  return {
    type: "buttons",
    body: [
      "*Cambio por confirmar*",
      `${rateNum(v.usd)} USDT → *${formatMoney(v.ves, "VES")}*`,
      `Tasa: ${rateNum(v.rate)}`,
      dateLine(v.businessDate, v.today),
    ].join("\n"),
    buttons: [
      { id: IDS.confirm(v.pendingId), title: "Guardar" },
      { id: IDS.cancel(v.pendingId), title: "Cancelar" },
    ],
  };
}

/** Cambio guardado; con `askMode`, pregunta si sus gastos en Bs salen de los cambios. */
export function exchangeSaved(v: {
  usd: Decimal.Value;
  ves: Decimal.Value;
  rate: Decimal.Value;
  left: Decimal.Value;
  askMode: boolean;
}): Outbound {
  const body = [
    `✅ Cambio guardado: ${rateNum(v.usd)} USDT → ${formatMoney(v.ves, "VES")} a ${rateNum(v.rate)}.`,
    `💱 Saldo de tus cambios: *${formatMoney(v.left, "VES")}*.`,
  ];
  if (!v.askMode) return { type: "text", body: body.join("\n") };
  body.push("", "¿Tus gastos en Bs salen de estos cambios?");
  return {
    type: "buttons",
    body: body.join("\n"),
    buttons: [
      { id: IDS.bsMode("usdt"), title: "Siempre" },
      { id: IDS.bsMode("ask"), title: "Preguntarme" },
      { id: IDS.bsMode("bcv"), title: "No, tasa BCV" },
    ],
  };
}

const BS_MODE_TEXT: Record<"bcv" | "usdt" | "ask", string> = {
  usdt: "siempre salen de tus cambios",
  ask: "te pregunto cada vez de dónde salieron",
  bcv: "van a la tasa BCV",
};

/** Saldo de los cambios: total y cada lote con saldo. */
export function exchangeBalance(v: {
  lots: { vesRemaining: Decimal.Value; rate: Decimal.Value; businessDate: string }[];
  mode: "bcv" | "usdt" | "ask";
}): Outbound {
  const modeLine = `Tus gastos en Bs ${BS_MODE_TEXT[v.mode]}.`;
  if (v.lots.length === 0)
    return {
      type: "text",
      body: `💱 No te quedan Bs de cambios. Cuando cambies, dímelo: _cambié 100 usdt a 970_\n${modeLine}`,
    };
  const total = v.lots.reduce((s, l) => s.plus(l.vesRemaining), new Decimal(0));
  const lines = [`💱 Te quedan *${formatMoney(total, "VES")}* de tus cambios:`];
  for (const l of v.lots.slice(0, 6))
    lines.push(
      `• ${formatMoney(l.vesRemaining, "VES")} a ${rateNum(l.rate)} (${formatShortDate(asIsoDate(l.businessDate))})`,
    );
  if (v.lots.length > 6) lines.push(`… y ${v.lots.length - 6} más.`);
  lines.push(modeLine);
  return { type: "text", body: lines.join("\n") };
}

export function bsModeSet(mode: "bcv" | "usdt" | "ask"): Outbound {
  return {
    type: "text",
    body: `Listo: tus gastos en Bs ${BS_MODE_TEXT[mode]}. Lo cambias en Ajustes cuando quieras.`,
  };
}

export function bsModeOwnerOnly(): Outbound {
  return { type: "text", body: "De dónde sale la tasa de los Bs lo decide el dueño del negocio." };
}

/** Va arriba del borrador que sale de una captura de Binance. */
export function exchangeShotRead(): Outbound {
  return { type: "text", body: "🧾 Leí tu cambio de Binance:" };
}

export function exchangeShotUnclear(): Outbound {
  return {
    type: "text",
    body: "Parece un cambio de USDT, pero no pude leer bien los montos. Escríbemelo: _cambié 30,88 usdt por 30.000 bs_",
  };
}

export function exchangeBuyShot(): Outbound {
  return {
    type: "text",
    body: "Es una compra de USDT (pagaste bolívares). Por ahora registro los cambios de USDT a Bs; si fue un gasto, escríbemelo.",
  };
}

export function exchangeInvalid(): Outbound {
  return {
    type: "text",
    body: "No entendí el cambio. Dime cuántos USDT cambiaste y a qué tasa o cuántos Bs te dieron: _cambié 100 usdt a 970_",
  };
}

/** Línea del equivalente: "Bs 9.739,28 · tasa euro 973,93" (con el día si la tasa es de otro). */
function equivalentLine(d: {
  currency: "USD" | "VES";
  amountUsd: Decimal.Value;
  amountVes: Decimal.Value;
  rateValue: Decimal.Value;
  rateSource?: RateOrigin | undefined;
  rateEffectiveDate?: string;
  businessDate?: string;
}): string {
  const other =
    d.currency === "USD" ? formatMoney(d.amountVes, "VES") : formatMoney(d.amountUsd, "USD");
  const otherDay =
    d.rateSource !== "manual" &&
    d.rateSource !== "exchange" &&
    d.rateEffectiveDate &&
    d.businessDate &&
    d.rateEffectiveDate !== d.businessDate
      ? ` del ${formatShortDate(asIsoDate(d.rateEffectiveDate))}`
      : "";
  return `${other} · ${rateLabel(d.rateValue, d.rateSource)}${otherDay}`;
}

/** Nota cuando la moneda no la dijo el usuario. */
function inferredNote(currency: "USD" | "VES"): string {
  return `_No dijiste la moneda: lo tomé en ${currency === "USD" ? "dólares" : "bolívares"}._`;
}

/** "Fecha: hoy, vie 02/10". */
function dateLine(businessDate: string, today: string): string {
  const r = relativeDay(businessDate, asIsoDate(today));
  return `Fecha: ${r.charAt(0).toLowerCase()}${r.slice(1)}`;
}

function relativeDay(businessDate: string, today: IsoDate): string {
  const d = asIsoDate(businessDate);
  const label = formatShortDate(d);
  if (d === today) return `Hoy, ${label}`;
  const [y, m, day] = today.split("-").map(Number);
  const yesterday = new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1, (day ?? 1) - 1))
    .toISOString()
    .slice(0, 10);
  return d === yesterday ? `Ayer, ${label}` : label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * Borrador de gasto, un dato por línea:
 *   *Gasto por confirmar*
 *   Productos de limpieza: *$10,00*
 *   Bs 9.739,28 · tasa euro 973,93
 *   Categoría: Insumos
 *   Fecha: hoy, vie 02/10
 */
export function expenseDraft(d: ExpenseDraftView): Outbound {
  const main = formatMoney(d.amount, d.currency);
  const lines: string[] = [];
  if (d.replacedPrevious) lines.push("Descarté el borrador anterior sin guardar.");
  if (d.transcript) lines.push(`Entendí: _"${d.transcript}"_`);
  lines.push("*Gasto por confirmar*");
  lines.push(d.description ? `${d.description}: *${main}*` : `*${main}*`);
  lines.push(equivalentLine(d));
  lines.push(`Categoría: ${d.categoryName ?? "Otros"}`);
  lines.push(dateLine(d.businessDate, d.today));
  if (d.currencyInferred) lines.push(inferredNote(d.currency));
  if (d.exchange) lines.push(exchangeNote(d.exchange));
  return {
    type: "buttons",
    body: lines.join("\n"),
    buttons: [
      { id: IDS.confirm(d.pendingId), title: "Guardar" },
      { id: IDS.fix(d.pendingId), title: "Corregir" },
      { id: IDS.cancel(d.pendingId), title: "Cancelar" },
    ],
  };
}

export type ExpensesDraftView = {
  pendingId: string;
  items: Omit<ExpenseDraftView, "pendingId" | "today" | "transcript" | "replacedPrevious">[];
  today: IsoDate;
  transcript: string | null;
  replacedPrevious: boolean;
};

/** Varios gastos de un mensaje: un renglón por gasto, el total en dólares y una sola confirmación. */
export function expensesDraft(v: ExpensesDraftView): Outbound {
  const lines: string[] = [];
  if (v.replacedPrevious) lines.push("Descarté el borrador anterior sin guardar.");
  if (v.transcript) lines.push(`Entendí: _"${v.transcript}"_`);
  lines.push(`*${v.items.length} gastos por confirmar*`);
  const sameDay = v.items.every((i) => i.businessDate === v.items[0]?.businessDate);
  let totalUsd = new Decimal(0);
  let totalVes = new Decimal(0);
  v.items.forEach((d, i) => {
    totalUsd = totalUsd.plus(d.amountUsd);
    totalVes = totalVes.plus(d.amountVes);
    const main = formatMoney(d.amount, d.currency);
    const day = sameDay ? "" : ` · ${relativeDay(d.businessDate, v.today).toLowerCase()}`;
    lines.push(
      `${i + 1}. ${d.description ?? "Sin descripción"}: *${main}* · ${d.categoryName ?? "Otros"}${day}`,
    );
  });
  const first = v.items[0];
  // Renglones de los lotes de cambio llevan cada uno su tasa: el total no muestra una sola.
  const fromLots = v.items.filter((i) => i.exchange);
  const rateText = fromLots.length
    ? " · de tus cambios"
    : first
      ? ` · ${rateLabel(first.rateValue, first.rateSource)}`
      : "";
  lines.push(
    `Total: *${formatMoney(totalUsd, "USD")}* · ${formatMoney(totalVes, "VES")}${rateText}`,
  );
  if (sameDay && first) lines.push(dateLine(first.businessDate, v.today));
  const inferred = v.items.find((i) => i.currencyInferred);
  if (inferred) lines.push(inferredNote(inferred.currency));
  const lastLot = fromLots[fromLots.length - 1]?.exchange;
  if (lastLot) {
    const uncovered = fromLots.reduce(
      (s, i) => s.plus(i.exchange?.uncoveredVes ?? 0),
      new Decimal(0),
    );
    lines.push(exchangeNote({ ...lastLot, uncoveredVes: uncovered.toFixed(2) }));
  }
  return {
    type: "buttons",
    body: lines.join("\n"),
    buttons: [
      { id: IDS.confirm(v.pendingId), title: "Guardar" },
      { id: IDS.fix(v.pendingId), title: "Corregir" },
      { id: IDS.cancel(v.pendingId), title: "Cancelar" },
    ],
  };
}

/** `budgetLines`: una línea por presupuesto tocado (solo al dueño), de `budgetLine`. */
export function expensesSaved(
  saved: number,
  dayTotalUsd: Decimal.Value,
  count: number,
  budgetLines: string[] = [],
  day = "hoy",
): Outbound {
  const n = count === 1 ? "1 registro" : `${count} registros`;
  return {
    type: "text",
    body: [
      `✅ Guardados ${saved} gastos. Gastos ${day === "hoy" ? "de hoy" : day}: *${formatMoney(dayTotalUsd, "USD")}* (${n}).`,
      ...budgetLines,
    ].join("\n"),
  };
}

export function expenseSaved(
  dayTotalUsd: Decimal.Value,
  count: number,
  budgetLines: string[] = [],
  day = "hoy",
): Outbound {
  const n = count === 1 ? "1 registro" : `${count} registros`;
  return {
    type: "text",
    body: [
      `✅ Guardado. Gastos ${day === "hoy" ? "de hoy" : day}: *${formatMoney(dayTotalUsd, "USD")}* (${n}).`,
      ...budgetLines,
    ].join("\n"),
  };
}

// ---------------------------------------------------------------- presupuestos (0009)

export type BudgetView = {
  name: string;
  period: "monthly" | "biweekly";
  amountUsd: Decimal;
  remainingUsd: Decimal;
  pct: number;
  from: IsoDate;
  to: IsoDate;
  daysLeft: number;
};

const BUDGET_WARN_PCT = 80;

/** "este mes", "esta quincena", "en septiembre", "en la 2ª quincena de septiembre". */
function budgetWhen(b: BudgetView, today: IsoDate): string {
  const current = b.from <= today && today <= b.to;
  if (b.period === "monthly")
    return current ? "este mes" : `en ${monthNameEs(b.from).toLowerCase()}`;
  if (current) return "esta quincena";
  const half = b.from.endsWith("-01") ? "1ª" : "2ª";
  return `en la ${half} quincena de ${monthNameEs(b.from).toLowerCase()}`;
}

/**
 * Cómo va un presupuesto en una línea: lo que queda, ⚠️ desde el 80 %, 🔴 en el tope o pasado.
 * "Insumos: te quedan *$45,00* de $200,00 este mes."
 */
export function budgetLine(b: BudgetView, today: IsoDate): string {
  const when = budgetWhen(b, today);
  const cap = formatMoney(b.amountUsd, "USD");
  if (b.remainingUsd.isNegative())
    return `🔴 ${b.name}: te pasaste por *${formatMoney(b.remainingUsd.abs(), "USD")}* del presupuesto de ${cap} ${when}.`;
  if (b.remainingUsd.isZero()) return `🔴 ${b.name}: llegaste al tope de ${cap} ${when}.`;
  const rest = `*${formatMoney(b.remainingUsd, "USD")}* de ${cap} ${when}.`;
  if (b.pct >= BUDGET_WARN_PCT) return `⚠️ ${b.name}: vas por el ${b.pct} %. Te quedan ${rest}`;
  return `${b.name}: te quedan ${rest}`;
}

const daysText = (n: number) => (n <= 1 ? "hoy es el último día" : `faltan ${n} días`);

/** Respuesta a "¿cuánto me queda en X?" o "¿cómo voy con los presupuestos?". */
export function budgetsSummary(list: BudgetView[], today: IsoDate): Outbound {
  if (list.length === 1) {
    const b = list[0] as BudgetView;
    const reset = b.period === "monthly" ? "el mes" : "la quincena";
    return {
      type: "text",
      body: `${budgetLine(b, today)}\n_${daysText(b.daysLeft).replace(/^./, (c) => c.toUpperCase())} para que se reinicie ${reset}._`,
    };
  }
  const lines = list.map((b) => {
    const cap = formatMoney(b.amountUsd, "USD");
    const tag = b.period === "biweekly" ? " · quincenal" : "";
    if (b.remainingUsd.isNegative())
      return `🔴 ${b.name}: pasado por *${formatMoney(b.remainingUsd.abs(), "USD")}* (tope ${cap}${tag})`;
    const icon = b.remainingUsd.isZero() || b.pct >= BUDGET_WARN_PCT ? "⚠️ " : "• ";
    return `${icon}${b.name}: quedan *${formatMoney(b.remainingUsd, "USD")}* de ${cap} (${b.pct} %${tag})`;
  });
  const foot: string[] = [];
  const monthly = list.find((b) => b.period === "monthly");
  const biweekly = list.find((b) => b.period === "biweekly");
  if (monthly) foot.push(`Mes: ${daysText(monthly.daysLeft)}.`);
  if (biweekly) foot.push(`Quincena: ${daysText(biweekly.daysLeft)}.`);
  return {
    type: "text",
    body: `*Presupuestos* · ${formatShortDate(today)}\n${lines.join("\n")}\n_${foot.join(" ")}_`,
  };
}

export function budgetsOwnerOnly(): Outbound {
  return {
    type: "text",
    body: "Los presupuestos los ve el dueño. Tú puedes registrar gastos y ventas.",
  };
}

export function noBudgets(dashboardUrl: string): Outbound {
  return {
    type: "text",
    body: `Todavía no tienes presupuestos. Ponlos en ${dashboardUrl}/ajustes/categorias: a cada categoría le das un tope en dólares, mensual o quincenal.`,
  };
}

export function categoryWithoutBudget(name: string, dashboardUrl: string): Outbound {
  return {
    type: "text",
    body: `${name} no tiene presupuesto. Ponlo en ${dashboardUrl}/ajustes/categorias.`,
  };
}

export function setBudgetInDashboard(dashboardUrl: string): Outbound {
  return {
    type: "text",
    body: `Los presupuestos se ponen en el dashboard: ${dashboardUrl}/ajustes/categorias. Ahí le das a cada categoría un tope en dólares, mensual o quincenal, y yo te aviso cuánto te queda cada vez que guardes un gasto.`,
  };
}

/** Moneda ambigua (sin moneda por defecto y monto bajo el umbral): dos botones, sin LLM al responder. */
export function currencyQuestion(amountText: string): Outbound {
  return {
    type: "buttons",
    body: `¿${amountText} en qué moneda?`,
    buttons: [
      { id: IDS.currency("USD"), title: "Dólares" },
      { id: IDS.currency("VES"), title: "Bolívares" },
    ],
  };
}

export function clarification(question: string, options: string[]): Outbound {
  if (options.length === 0) return { type: "text", body: question };
  return { type: "text", body: `${question}\n${options.map((o) => `• ${o}`).join("\n")}` };
}

// ---------------------------------------------------------------- ingresos (Fase 4, "registrar venta")

export type IncomeLineView = {
  method: string;
  amount: Decimal.Value;
  currency: "USD" | "VES";
  amountUsd: Decimal.Value;
  amountVes: Decimal.Value;
};

export type IncomeDayTotalView = {
  pendingId: string;
  rateSource?: RateOrigin;
  businessDate: string;
  today: string;
  lines: IncomeLineView[];
  totalUsd: Decimal.Value;
  totalVes: Decimal.Value;
  rateValue: Decimal.Value;
  rateEffectiveDate: string;
  mismatch: { statedUsd: Decimal.Value; breakdownUsd: Decimal.Value } | null;
  existingUsd: Decimal.Value | null;
  transcript: string | null;
  replacedPrevious: boolean;
  methodLabel: (method: string) => string;
};

function lineText(l: IncomeLineView, label: string): string {
  const main = formatMoney(l.amount, l.currency);
  return l.currency === "VES"
    ? `${label}: *${main}* (${formatMoney(l.amountUsd, "USD")})`
    : `${label}: *${main}*`;
}

export function incomeDayTotalDraft(v: IncomeDayTotalView): Outbound {
  const lines: string[] = [];
  if (v.replacedPrevious) lines.push("Descarté el borrador anterior sin guardar.");
  if (v.transcript) lines.push(`Entendí: _"${v.transcript}"_`);
  if (v.mismatch) {
    lines.push(
      `El desglose suma *${formatMoney(v.mismatch.breakdownUsd, "USD")}* y el total es *${formatMoney(v.mismatch.statedUsd, "USD")}*.`,
    );
    const diff = new Decimal(v.mismatch.statedUsd).minus(v.mismatch.breakdownUsd);
    lines.push(
      diff.gt(0)
        ? `Faltan *${formatMoney(diff, "USD")}*. ¿Cómo lo dejo?`
        : `Sobran *${formatMoney(diff.abs(), "USD")}*. ¿Cómo lo dejo?`,
    );
    const buttons = [];
    if (diff.gt(0))
      buttons.push({
        id: IDS.choice(v.pendingId, "stated"),
        title: shortTotal(v.mismatch.statedUsd),
      });
    buttons.push({
      id: IDS.choice(v.pendingId, "breakdown"),
      title: shortTotal(v.mismatch.breakdownUsd),
    });
    buttons.push({ id: IDS.fix(v.pendingId), title: "Corregir" });
    return { type: "buttons", body: lines.join("\n"), buttons };
  }
  lines.push("*Venta del día por confirmar*");
  for (const l of v.lines) lines.push(lineText(l, v.methodLabel(l.method)));
  lines.push(
    `Total: *${formatMoney(v.totalUsd, "USD")}* · ${formatMoney(v.totalVes, "VES")} · ${rateLabel(v.rateValue, v.rateSource)}`,
  );
  lines.push(dateLine(v.businessDate, v.today));
  if (v.lines.length === 1 && v.lines[0]?.method === "unspecified")
    lines.push("Si quieres, dime el desglose: _200 efectivo, 80 pago móvil_");
  if (v.existingUsd !== null) {
    lines.push(
      `Ya tienes una venta del día registrada ese día por *${formatMoney(v.existingUsd, "USD")}*.`,
    );
    return {
      type: "buttons",
      body: lines.join("\n"),
      buttons: [
        { id: IDS.choice(v.pendingId, "replace"), title: "Reemplazar" },
        { id: IDS.choice(v.pendingId, "append"), title: "Agregar" },
        { id: IDS.cancel(v.pendingId), title: "Cancelar" },
      ],
    };
  }
  return {
    type: "buttons",
    body: lines.join("\n"),
    buttons: [
      { id: IDS.confirm(v.pendingId), title: "Guardar" },
      { id: IDS.fix(v.pendingId), title: "Corregir" },
      { id: IDS.cancel(v.pendingId), title: "Cancelar" },
    ],
  };
}

/** Título de botón (máximo 20 caracteres): "Total $350" o "Total $1,2 MM". */
function shortTotal(usd: Decimal.Value): string {
  const d = new Decimal(usd);
  const body = d.gte(1_000_000)
    ? `${d.div(1_000_000).toDecimalPlaces(1).toString().replace(".", ",")} MM`
    : d.eq(d.toDecimalPlaces(0))
      ? d.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ".")
      : formatMoney(d, "USD").slice(1);
  return `Total $${body}`.slice(0, 20);
}

export type IncomeSingleView = {
  pendingId: string;
  rateSource?: RateOrigin;
  amount: Decimal.Value;
  currency: "USD" | "VES";
  currencyInferred: boolean;
  amountUsd: Decimal.Value;
  amountVes: Decimal.Value;
  rateValue: Decimal.Value;
  rateEffectiveDate: string;
  businessDate: string;
  today: string;
  methodLabel: string;
  /** "unspecified" omite el "por …": no se dijo cómo pagaron. */
  method?: string;
  description: string | null;
  transcript: string | null;
  replacedPrevious: boolean;
};

export function incomeSingleDraft(v: IncomeSingleView): Outbound {
  const main = formatMoney(v.amount, v.currency);
  const lines: string[] = [];
  if (v.replacedPrevious) lines.push("Descarté el borrador anterior sin guardar.");
  if (v.transcript) lines.push(`Entendí: _"${v.transcript}"_`);
  lines.push("*Ingreso por confirmar*");
  const how = v.method === "unspecified" ? "" : ` por ${v.methodLabel}`;
  lines.push(v.description ? `${v.description}: *${main}*${how}` : `*${main}*${how}`);
  lines.push(equivalentLine(v));
  lines.push(dateLine(v.businessDate, v.today));
  if (v.currencyInferred) lines.push(inferredNote(v.currency));
  return {
    type: "buttons",
    body: lines.join("\n"),
    buttons: [
      { id: IDS.confirm(v.pendingId), title: "Guardar" },
      { id: IDS.fix(v.pendingId), title: "Corregir" },
      { id: IDS.cancel(v.pendingId), title: "Cancelar" },
    ],
  };
}

export function incomeSaved(
  salesUsd: Decimal.Value,
  expensesUsd: Decimal.Value,
  opts: { replaced: number; isToday: boolean; dateLabel: string },
): Outbound {
  const when = opts.isToday ? "Hoy" : opts.dateLabel;
  const note = opts.replaced > 0 ? " Reemplacé la venta anterior de ese día." : "";
  return {
    type: "text",
    body: `✅ Venta guardada.${note} ${when}: vendiste *${formatMoney(salesUsd, "USD")}*, gastaste *${formatMoney(expensesUsd, "USD")}*.`,
  };
}

// ---------------------------------------------------------------- cierre y consultas (Épica D)

export type DailyCloseView = {
  date: string;
  today: string;
  salesUsd: Decimal.Value;
  salesByMethod: { label: string; usd: Decimal.Value; originalVes: Decimal.Value }[];
  expensesUsd: Decimal.Value;
  expensesByCategory: { name: string; usd: Decimal.Value }[];
  netUsd: Decimal.Value;
  netVes: Decimal.Value | null;
  rateValue: Decimal.Value | null;
  cashUsd: Decimal.Value;
  cashVes: Decimal.Value;
  count: number;
  dashboardUrl: string;
};

const MAX_LINES_PER_BLOCK = 6;

function signedUsd(v: Decimal.Value): string {
  const d = new Decimal(v);
  return d.isNegative() ? `−${formatMoney(d.abs(), "USD")}` : formatMoney(d, "USD");
}

function capped<T>(
  items: T[],
  line: (t: T) => string,
  rest: (n: number, items: T[]) => string,
): string[] {
  if (items.length <= MAX_LINES_PER_BLOCK) return items.map(line);
  const head = items.slice(0, MAX_LINES_PER_BLOCK - 1);
  const tail = items.slice(MAX_LINES_PER_BLOCK - 1);
  return [...head.map(line), rest(tail.length, tail)];
}

const sumUsd = (items: { usd: Decimal.Value }[]) =>
  items.reduce((acc, i) => acc.plus(i.usd), new Decimal(0));

export function dailyClose(v: DailyCloseView): Outbound {
  const title =
    v.date === v.today
      ? `📊 Cierre diario · hoy, ${formatShortDate(asIsoDate(v.date))}`
      : `📊 Cierre diario · ${formatShortDate(asIsoDate(v.date))}`;
  const lines = [title, ""];
  lines.push(`*Ventas: ${formatMoney(v.salesUsd, "USD")}*`);
  lines.push(
    ...capped(
      v.salesByMethod,
      (m) =>
        new Decimal(m.originalVes).gt(0)
          ? `${m.label} ${formatMoney(m.usd, "USD")} (${formatMoney(m.originalVes, "VES")})`
          : `${m.label} ${formatMoney(m.usd, "USD")}`,
      (n, items) => `Otros ${n} · ${formatMoney(sumUsd(items), "USD")}`,
    ),
  );
  lines.push("");
  lines.push(`*Gastos: ${formatMoney(v.expensesUsd, "USD")}*`);
  lines.push(
    ...capped(
      v.expensesByCategory,
      (c) => `${c.name} ${formatMoney(c.usd, "USD")}`,
      (n, items) => `Otros ${n} · ${formatMoney(sumUsd(items), "USD")}`,
    ),
  );
  lines.push("");
  const net = `*Ventas menos gastos: ${signedUsd(v.netUsd)}*`;
  lines.push(
    v.netVes !== null && v.rateValue !== null
      ? `${net} (${formatMoney(v.netVes, "VES")} a tasa ${formatMoney(v.rateValue, "VES").replace("Bs ", "")})`
      : net,
  );
  lines.push("");
  lines.push(
    `Efectivo en caja: ${formatMoney(v.cashUsd, "USD")} · ${formatMoney(v.cashVes, "VES")}`,
  );
  lines.push(
    `${v.count === 1 ? "1 movimiento" : `${v.count} movimientos`} · Dashboard: ${v.dashboardUrl}`,
  );
  return { type: "text", body: lines.join("\n") };
}

export function noMovements(label: string): Outbound {
  return {
    type: "text",
    body: `No tengo movimientos registrados ${label}. Si vendiste o gastaste algo, dímelo y lo anoto.`,
  };
}

export type PeriodSummaryView = {
  title: string;
  salesUsd: Decimal.Value;
  expensesUsd: Decimal.Value;
  netUsd: Decimal.Value;
  topExpenses: { name: string; usd: Decimal.Value }[];
  daysWithMovements: number;
  dashboardUrl: string;
};

export function periodSummary(v: PeriodSummaryView): Outbound {
  const lines = [`📊 ${v.title}`, ""];
  lines.push(`*Ventas: ${formatMoney(v.salesUsd, "USD")}*`);
  lines.push(`*Gastos: ${formatMoney(v.expensesUsd, "USD")}*`);
  lines.push(`*Ventas menos gastos: ${signedUsd(v.netUsd)}*`);
  if (v.topExpenses.length) {
    lines.push("");
    lines.push("Gastos más grandes:");
    for (const c of v.topExpenses.slice(0, 5)) lines.push(`${c.name} ${formatMoney(c.usd, "USD")}`);
  }
  lines.push("");
  lines.push(
    `${v.daysWithMovements === 1 ? "1 día" : `${v.daysWithMovements} días`} con movimientos · Dashboard: ${v.dashboardUrl}`,
  );
  return { type: "text", body: lines.join("\n") };
}

export function categoryTotal(v: {
  name: string;
  periodLabel: string;
  usd: Decimal.Value;
  ves: Decimal.Value;
  count: number;
}): Outbound {
  if (v.count === 0)
    return { type: "text", body: `${v.name}, ${v.periodLabel}: sin gastos registrados.` };
  return {
    type: "text",
    body: `${v.name}, ${v.periodLabel}: *${formatMoney(v.usd, "USD")}* (${formatMoney(v.ves, "VES")}) en ${v.count === 1 ? "1 gasto" : `${v.count} gastos`}.`,
  };
}

export function categoryNotFound(name: string, suggestions: string[]): Outbound {
  return {
    type: "text",
    body: `No tengo una categoría "${name}". ${suggestions.length ? `¿Te refieres a alguna de estas? ${suggestions.join(", ")}` : ""}`.trim(),
  };
}

export function periodTooLong(dashboardUrl: string): Outbound {
  return {
    type: "text",
    body: `Por chat consulto hasta 12 meses. Para más, usa el dashboard: ${dashboardUrl}`,
  };
}

/** "hoy", "ayer", "esta semana (lun 22 al 29/09)", "septiembre (1 al 29)", "del 01/09 al 15/09". */
export function periodLabel(key: string, from: IsoDate, to: IsoDate, today: IsoDate): string {
  const d = (x: IsoDate) => x.slice(8, 10).replace(/^0/, "");
  switch (key) {
    case "today":
      return "hoy";
    case "yesterday":
      return "ayer";
    case "this_week":
      return `esta semana (${formatShortDate(from)} al ${formatShortDate(to)})`;
    case "last_week":
      return `la semana pasada (${formatShortDate(from)} al ${formatShortDate(to)})`;
    case "this_month":
      return `${monthNameEs(from).toLowerCase()} (1 al ${d(to)})`;
    case "last_month":
      return `${monthNameEs(from).toLowerCase()} completo`;
    default:
      return from === to
        ? formatShortDate(from)
        : `del ${from.slice(8, 10)}/${from.slice(5, 7)} al ${to.slice(8, 10)}/${to.slice(5, 7)}${to === today ? "" : ""}`;
  }
}

// ---------------------------------------------------------------- corregir y borrar el último (US-B8)

export type Snapshot = {
  amount: Decimal.Value;
  currency: "USD" | "VES";
  amountUsd: Decimal.Value;
  amountVes: Decimal.Value;
  rateValue: Decimal.Value;
  rateSource: RateOrigin;
  businessDate: string;
  categoryName: string | null;
  description: string | null;
  paymentMethod: string;
};

function shortMovement(
  s: Snapshot,
  type: "expense" | "income",
  methodLabel: (m: string) => string,
) {
  const what =
    type === "expense"
      ? (s.description ?? s.categoryName ?? "Gasto")
      : (s.description ?? methodLabel(s.paymentMethod));
  return `${what} · ${formatMoney(s.amount, s.currency)}`;
}

export function amendDraft(v: {
  pendingId: string;
  type: "expense" | "income";
  before: Snapshot;
  after: Snapshot;
  changed: string[];
  methodLabel: (m: string) => string;
}): Outbound {
  const kind = v.type === "expense" ? "gasto" : "ingreso";
  const lines = [`Cambio el último ${kind}:`];
  const b = v.before;
  const a = v.after;
  const has = (k: string) => v.changed.includes(k);
  const what =
    v.type === "expense"
      ? (b.description ?? b.categoryName ?? "Gasto")
      : (b.description ?? v.methodLabel(b.paymentMethod));
  if (has("amount") || has("currency") || has("rateValue"))
    lines.push(
      `${what} · ${formatMoney(b.amount, b.currency)} → *${formatMoney(a.amount, a.currency)}*${a.rateSource !== "bcv" ? ` (${rateLabel(a.rateValue, a.rateSource)})` : ""}`,
    );
  else lines.push(`${what} · ${formatMoney(b.amount, b.currency)}`);
  if (has("description"))
    lines.push(`Descripción: ${b.description ?? "—"} → *${a.description ?? "—"}*`);
  if (has("categoryName"))
    lines.push(`Categoría: ${b.categoryName ?? "Otros"} → *${a.categoryName ?? "Otros"}*`);
  if (has("paymentMethod"))
    lines.push(`Método: ${v.methodLabel(b.paymentMethod)} → *${v.methodLabel(a.paymentMethod)}*`);
  if (has("businessDate"))
    lines.push(
      `Fecha: ${formatShortDate(asIsoDate(b.businessDate))} → *${formatShortDate(asIsoDate(a.businessDate))}*`,
    );
  return {
    type: "buttons",
    body: lines.join("\n"),
    buttons: [
      { id: IDS.confirm(v.pendingId), title: "Guardar" },
      { id: IDS.cancel(v.pendingId), title: "Cancelar" },
    ],
  };
}

export function deleteDraft(v: {
  pendingId: string;
  type: "expense" | "income";
  snapshot: Snapshot;
  today: string;
  methodLabel: (m: string) => string;
  /** false cuando se eligió por nombre ("borra el de la arepa") y no es el último. */
  latest?: boolean;
}): Outbound {
  const kind = v.type === "expense" ? "gasto" : "ingreso";
  return {
    type: "buttons",
    body: `Elimino ${v.latest === false ? "este" : "el último"} ${kind}: ${shortMovement(v.snapshot, v.type, v.methodLabel)} · ${relativeDay(v.snapshot.businessDate, asIsoDate(v.today)).toLowerCase()}.`,
    buttons: [
      { id: IDS.confirm(v.pendingId), title: "Eliminar" },
      { id: IDS.cancel(v.pendingId), title: "Cancelar" },
    ],
  };
}

export function deleteManyDraft(v: {
  pendingId: string;
  items: { type: "expense" | "income"; snapshot: Snapshot }[];
  today: string;
  methodLabel: (m: string) => string;
  /** Si pidió más de los que caben en 30 minutos, el enlace para borrar los demás. */
  dashboardUrl: string | null;
}): Outbound {
  const sameType = v.items.every((i) => i.type === v.items[0]?.type);
  const noun = !sameType ? "movimientos" : v.items[0]?.type === "expense" ? "gastos" : "ingresos";
  const lines = [`Elimino ${v.items.length} ${noun}:`];
  v.items.forEach((i, n) => {
    const kind = sameType ? "" : i.type === "expense" ? "Gasto · " : "Ingreso · ";
    const day = relativeDay(i.snapshot.businessDate, asIsoDate(v.today)).toLowerCase();
    lines.push(`${n + 1}. ${kind}${shortMovement(i.snapshot, i.type, v.methodLabel)} · ${day}`);
  });
  if (v.dashboardUrl)
    lines.push(`Los anteriores tienen más de 30 minutos: esos se borran en ${v.dashboardUrl}`);
  return {
    type: "buttons",
    body: lines.join("\n"),
    buttons: [
      { id: IDS.confirm(v.pendingId), title: "Eliminar" },
      { id: IDS.cancel(v.pendingId), title: "Cancelar" },
    ],
  };
}

export function tooOld(dashboardUrl: string): Outbound {
  return {
    type: "text",
    body: `Ese movimiento ya tiene más de 30 minutos. Lo puedes corregir aquí: ${dashboardUrl}/movimientos`,
  };
}

export function nothingToAmend(): Outbound {
  return { type: "text", body: "No tengo ningún movimiento tuyo reciente para corregir." };
}

export function amended(
  type: "expense" | "income",
  totals: { usd: Decimal.Value; count: number },
): Outbound {
  const label = type === "expense" ? "Gastos" : "Ventas";
  return {
    type: "text",
    body: `✅ Corregido. ${label} de ese día: *${formatMoney(totals.usd, "USD")}* (${totals.count === 1 ? "1 registro" : `${totals.count} registros`}).`,
  };
}

export function deleted(
  type: "expense" | "income",
  totals: { usd: Decimal.Value; count: number },
): Outbound {
  const label = type === "expense" ? "Gastos" : "Ventas";
  return {
    type: "text",
    body: `✅ Eliminado. ${label} de ese día: *${formatMoney(totals.usd, "USD")}* (${totals.count === 1 ? "1 registro" : `${totals.count} registros`}).`,
  };
}

export function deletedMany(
  removed: number,
  requested: number,
  type: "expense" | "income" | null,
  totals: { usd: Decimal.Value; count: number } | null,
): Outbound {
  const head =
    removed === requested
      ? `✅ Eliminados ${removed} movimientos.`
      : `✅ Eliminados ${removed} de ${requested}; los demás ya no existían.`;
  const tail =
    type && totals
      ? ` ${type === "expense" ? "Gastos" : "Ventas"} de ese día: *${formatMoney(totals.usd, "USD")}* (${totals.count === 1 ? "1 registro" : `${totals.count} registros`}).`
      : "";
  return { type: "text", body: `${head}${tail}` };
}

export function alreadyGone(): Outbound {
  return {
    type: "text",
    body: "Ese movimiento ya no existe o ya fue corregido. Revisa el dashboard si tienes dudas.",
  };
}

type ConvCurrency = "USD" | "VES" | "EUR";

/** Monto en cualquiera de las tres monedas: "$15,00", "Bs 12.870,00", "17,00 €". */
function money3(v: Decimal, c: ConvCurrency): string {
  return c === "EUR" ? `${formatMoney(v, "VES").replace("Bs ", "")} €` : formatMoney(v, c);
}

/** Calculadora (03/10): "🧮 8.000,00 Bs son *$9,32*" con la tasa usada debajo. */
export function conversion(c: {
  amount: Decimal;
  from: ConvCurrency;
  result: Decimal;
  to: ConvCurrency;
  extra: { amount: Decimal; currency: ConvCurrency } | null;
  rates: { value: Decimal; kind: "bcv" | "euro" | "manual"; effectiveDate: string }[];
}): Outbound {
  const main = `🧮 ${money3(c.amount, c.from)} son *${money3(c.result, c.to)}*`;
  const lines = [c.extra ? `${main} (≈ ${money3(c.extra.amount, c.extra.currency)})` : main];
  for (const r of c.rates) {
    const v = formatMoney(r.value, "VES");
    if (r.kind === "manual") lines.push(`A tasa ${v.replace("Bs ", "")}.`);
    else
      lines.push(
        `${r.kind === "euro" ? "Tasa euro BCV" : "Tasa BCV"}: ${v} (vigente ${formatShortDate(asIsoDate(r.effectiveDate))}).`,
      );
  }
  return { type: "text", body: lines.join("\n") };
}

/** Saldo de los lotes de cambio tras guardar un gasto en Bs. */
export function exchangeLeft(left: Decimal): string {
  return left.gte("0.01")
    ? `💱 Te quedan *${formatMoney(left, "VES")}* de tus cambios.`
    : "💱 Se acabaron los Bs de tus cambios. Cuando cambies de nuevo, dímelo: _cambié 100 usdt a 970_";
}

export function noRate(): Outbound {
  return {
    type: "text",
    body: "No tengo la tasa BCV para esa fecha, así que no puedo convertir. Inténtalo más tarde.",
  };
}
