import { formatShortDate, type IsoDate } from "../domain/dates.js";
import { type Decimal, formatMoney } from "../domain/money.js";
import { IDS, type Outbound } from "./outbound.js";

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

export function outOfScope(): Outbound {
  return {
    type: "buttons",
    body: "Solo te ayudo con tu caja: registrar gastos, registrar ventas y ver el cierre. ¿Qué quieres hacer?",
    buttons: MENU_BUTTONS,
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

export function cancelled(): Outbound {
  return { type: "text", body: "Listo, descartado. No guardé nada." };
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

export function unsupported(): Outbound {
  return { type: "text", body: "Solo entiendo texto, notas de voz y fotos de facturas." };
}

export function tooLong(): Outbound {
  return { type: "text", body: "Ese mensaje es muy largo. Mándame un gasto o una venta a la vez." };
}
