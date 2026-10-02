import { asIsoDate, formatShortDate, type IsoDate, monthNameEs } from "../domain/dates";
import { Decimal, formatMoney, type RateOrigin } from "../domain/money";
import { IDS, type Outbound } from "./outbound";

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
      "También me puedes mandar una nota de voz o la foto de una factura.\n\n" +
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
    "• Registrar gastos: _gasté 15$ en champú_, o nota de voz, o foto de la factura",
    "• Registrar ventas: _hoy vendí 350$: 200 efectivo, 150 pago móvil_",
    "• Cierre: _cierre de hoy_, _cómo va el mes_, _cuánto gasté en insumos esta semana_",
    "• Tasa: _tasa_",
    `Para ver, corregir o exportar todo: ${dashboardUrl}`,
  ];
  if (supportHint) lines.push(`Si algo no funciona, escribe a una persona: ${supportHint}`);
  return { type: "text", body: lines.join("\n") };
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
  const contact = supportHint
    ? `Para renovarlo escríbenos: ${supportHint}`
    : "Para renovarlo escríbele a quien te dio de alta.";
  return {
    type: "text",
    body: `Tu plan del asistente venció y por ahora no puedo registrar nada. Tus datos siguen guardados. ${contact}`,
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
    body: "Dime el gasto. Ejemplo: _gasté 15$ en champú_ o mándame la foto de la factura.",
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

/** Qué leyó el sistema en la foto; va en el mismo envío que el borrador. */
export function receiptRead(r: {
  vendor: string;
  date: string;
  total: string;
  currency: string;
}): Outbound {
  const parts = [r.vendor || "proveedor no legible"];
  if (r.total) parts.push(`${r.total} ${r.currency === "unknown" ? "" : r.currency}`.trim());
  if (r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) parts.push(formatShortDate(asIsoDate(r.date)));
  return { type: "text", body: `🧾 Leí la factura: ${parts.join(" · ")}` };
}

export function receiptUnclear(): Outbound {
  return { type: "text", body: "No pude leer bien la factura. ¿Cuánto fue y en qué moneda?" };
}

export function notAReceipt(): Outbound {
  return {
    type: "text",
    body: "Solo proceso fotos de facturas y recibos. Si es un gasto, escríbemelo: _gasté 15$ en champú_",
  };
}

export function imageTooBig(): Outbound {
  return {
    type: "text",
    body: "La foto es muy pesada (más de 5 MB). Mándala de nuevo con menos resolución.",
  };
}

export function unsupported(): Outbound {
  return { type: "text", body: "Solo entiendo texto, notas de voz y fotos de facturas." };
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
};

/** "tasa 866,56", "tasa euro 973,93" o "tasa 850,00 (manual)". */
export function rateLabel(value: Decimal.Value, source?: RateOrigin): string {
  const n = formatMoney(value, "VES").replace("Bs ", "");
  if (source === "bcv_eur") return `tasa euro ${n}`;
  if (source === "manual") return `tasa ${n} (manual)`;
  return `tasa ${n}`;
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

export function expenseDraft(d: ExpenseDraftView): Outbound {
  const main = formatMoney(d.amount, d.currency);
  const other =
    d.currency === "USD" ? formatMoney(d.amountVes, "VES") : formatMoney(d.amountUsd, "USD");
  const inferred = d.currencyInferred
    ? ` · entendí ${d.currency === "USD" ? "dólares" : "bolívares"}`
    : "";
  const rateNote =
    d.rateSource === "manual" || d.rateEffectiveDate === d.businessDate
      ? `a ${rateLabel(d.rateValue, d.rateSource)}`
      : `a ${rateLabel(d.rateValue, d.rateSource)} del ${formatShortDate(asIsoDate(d.rateEffectiveDate))}`;
  const lines: string[] = [];
  if (d.replacedPrevious) lines.push("Descarté el borrador anterior sin guardar.");
  if (d.transcript) lines.push(`Entendí: _"${d.transcript}"_`);
  lines.push("Gasto por confirmar:");
  lines.push(`*${main}* (${other} ${rateNote})${inferred}`);
  lines.push(`${d.description ?? "Sin descripción"} · ${d.categoryName ?? "Otros"}`);
  lines.push(relativeDay(d.businessDate, d.today));
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
  lines.push(`${v.items.length} gastos por confirmar:`);
  const sameDay = v.items.every((i) => i.businessDate === v.items[0]?.businessDate);
  let totalUsd = new Decimal(0);
  let totalVes = new Decimal(0);
  v.items.forEach((d, i) => {
    totalUsd = totalUsd.plus(d.amountUsd);
    totalVes = totalVes.plus(d.amountVes);
    const main = formatMoney(d.amount, d.currency);
    const other =
      d.currency === "USD" ? formatMoney(d.amountVes, "VES") : formatMoney(d.amountUsd, "USD");
    const day = sameDay ? "" : ` · ${relativeDay(d.businessDate, v.today).toLowerCase()}`;
    lines.push(
      `${i + 1}. *${main}* (${other}) · ${d.description ?? "Sin descripción"} · ${d.categoryName ?? "Otros"}${day}`,
    );
  });
  const first = v.items[0];
  const rateNote = first ? ` · a ${rateLabel(first.rateValue, first.rateSource)}` : "";
  const inferred = v.items.some((i) => i.currencyInferred)
    ? ` · entendí ${first?.currency === "USD" ? "dólares" : "bolívares"}`
    : "";
  lines.push(
    `Total: *${formatMoney(totalUsd, "USD")}* (${formatMoney(totalVes, "VES")}${rateNote})${inferred}`,
  );
  if (sameDay && first) lines.push(relativeDay(first.businessDate, v.today));
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

export function expensesSaved(saved: number, dayTotalUsd: Decimal.Value, count: number): Outbound {
  const n = count === 1 ? "1 registro" : `${count} registros`;
  return {
    type: "text",
    body: `✅ Guardados ${saved} gastos. Gastos de hoy: *${formatMoney(dayTotalUsd, "USD")}* (${n}).`,
  };
}

export function expenseSaved(dayTotalUsd: Decimal.Value, count: number): Outbound {
  const n = count === 1 ? "1 registro" : `${count} registros`;
  return {
    type: "text",
    body: `✅ Guardado. Gastos de hoy: *${formatMoney(dayTotalUsd, "USD")}* (${n}).`,
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
  const other =
    l.currency === "USD" ? formatMoney(l.amountVes, "VES") : formatMoney(l.amountUsd, "USD");
  return `${label} · *${main}* (${other})`;
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
  lines.push(
    `Venta del día por confirmar (${relativeDay(v.businessDate, asIsoDate(v.today)).toLowerCase()}):`,
  );
  for (const l of v.lines) lines.push(lineText(l, v.methodLabel(l.method)));
  lines.push(
    `Total *${formatMoney(v.totalUsd, "USD")}* (${formatMoney(v.totalVes, "VES")} a ${rateLabel(v.rateValue, v.rateSource)})`,
  );
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
  description: string | null;
  transcript: string | null;
  replacedPrevious: boolean;
};

export function incomeSingleDraft(v: IncomeSingleView): Outbound {
  const main = formatMoney(v.amount, v.currency);
  const other =
    v.currency === "USD" ? formatMoney(v.amountVes, "VES") : formatMoney(v.amountUsd, "USD");
  const inferred = v.currencyInferred
    ? ` · entendí ${v.currency === "USD" ? "dólares" : "bolívares"}`
    : "";
  const lines: string[] = [];
  if (v.replacedPrevious) lines.push("Descarté el borrador anterior sin guardar.");
  if (v.transcript) lines.push(`Entendí: _"${v.transcript}"_`);
  lines.push("Ingreso por confirmar:");
  lines.push(
    `*${main}* (${other} a ${rateLabel(v.rateValue, v.rateSource)}) · ${v.methodLabel}${inferred}`,
  );
  if (v.description) lines.push(`"${v.description}"`);
  lines.push(relativeDay(v.businessDate, asIsoDate(v.today)));
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
      `${what} · ${formatMoney(b.amount, b.currency)} → *${formatMoney(a.amount, a.currency)}*${a.rateSource === "manual" ? ` (a tasa ${formatMoney(a.rateValue, "VES").replace("Bs ", "")} manual)` : a.rateSource === "bcv_eur" ? ` (a ${rateLabel(a.rateValue, a.rateSource)})` : ""}`,
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

export function noRate(): Outbound {
  return {
    type: "text",
    body: "No tengo la tasa BCV para esa fecha, así que no puedo convertir. Inténtalo más tarde.",
  };
}
