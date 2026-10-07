/**
 * Planes y límites (borrador del modelo de negocio, `docs/MODELO-NEGOCIO.md`). Una sola fuente
 * para la landing, el panel de administración y el aviso de límite del worker. Los precios son
 * hipótesis hasta cerrar el piloto; se cambian aquí y todo lo demás los refleja.
 */
export type PlanId = "personal" | "negocio" | "negocio_plus";

export type Plan = {
  id: PlanId;
  name: string;
  priceUsd: number;
  tagline: string;
  /** Mensajes del usuario al asistente por mes (los del bot y las reacciones no cuentan). */
  messagesPerMonth: number;
  numbers: number;
  employees: number;
  features: string[];
  highlight?: boolean;
};

export const PLANS: Plan[] = [
  {
    id: "personal",
    name: "Personal",
    priceUsd: 5.99,
    tagline: "Un asistente para tu plata de todos los días, sin abrir una app.",
    messagesPerMonth: 120,
    numbers: 1,
    employees: 0,
    features: [
      "1 número de WhatsApp",
      "120 mensajes al mes (unos 4 al día)",
      "Texto, notas de voz y fotos",
      "Bs y $ con la tasa BCV del día",
      "Resumen de la semana y del mes",
      "Dashboard y exportación a Excel",
    ],
  },
  {
    id: "negocio",
    name: "Negocio",
    priceUsd: 19.99,
    tagline: "Hace la parte de la caja que hoy hace una persona. Tú y un empleado.",
    messagesPerMonth: 400,
    numbers: 2,
    employees: 1,
    features: [
      "Tu número + 1 empleado",
      "400 mensajes al mes (unos 13 al día)",
      "Ventas con desglose por método de pago",
      "Cierre del día con efectivo en caja",
      "Categorías propias y auditoría de cambios",
      "Dashboard, corrección y Excel",
    ],
    highlight: true,
  },
  {
    id: "negocio_plus",
    name: "Negocio Plus",
    priceUsd: 39.99,
    tagline: "Varios turnos o varias personas registrando. Mismo asistente.",
    messagesPerMonth: 1000,
    numbers: 4,
    employees: 3,
    features: [
      "Tu número + 3 empleados",
      "1.000 mensajes al mes",
      "Todo lo del plan Negocio",
      "Soporte por WhatsApp en horario de oficina",
    ],
  },
];

/**
 * Beta (07/10/2026, decisión de Javier): la web no muestra precios; dice "14 días gratis" (la
 * prueba de siempre, contada desde el registro).
 * Los precios de `PLANS` siguen definidos para el cobro y se publican al apagar esto.
 */
export const BETA = true;

export const PILOT_NOTE =
  "Durante la beta no se cobra. Estos son los precios al salir de la beta, y se avisan con 30 días de anticipación.";

export function planById(id: string): Plan {
  return PLANS.find((p) => p.id === id) ?? (PLANS[1] as Plan);
}

/**
 * Recargas (07/10/2026): al llegar al tope del mes, mensajes extra que valen hasta fin de mes.
 * Precio ≥ 2 veces el costo en el peor caso (~$0,021 por mensaje: IA + Meta). La grande sale más
 * barata por mensaje para empujarla.
 */
export type RechargePack = { id: "s" | "m"; messages: number; priceUsd: number };
export const RECHARGES: readonly RechargePack[] = [
  { id: "s", messages: 20, priceUsd: 1 },
  { id: "m", messages: 100, priceUsd: 4 },
];
/** La recarga grande: la que regala el administrador y la de los botones viejos. */
export const RECHARGE = RECHARGES[1] as RechargePack;
export function rechargeById(id: string | null | undefined): RechargePack {
  return RECHARGES.find((r) => r.id === id) ?? RECHARGE;
}

/**
 * Prueba gratis única (07/10/2026, decisión de Javier): 14 días o 100 mensajes, lo que llegue
 * primero, igual para todos. El plan se elige al pagar: así nadie escoge Plus para tener más
 * prueba. Quien la agota con uso real es el mejor momento para cobrar; si vale la pena, el
 * administrador le regala mensajes desde /admin.
 */
export const TRIAL_MESSAGES = 100;
/**
 * Red de seguridad de la prueba en USD (IA + Meta + voz), por si alguien manda muchas fotos:
 * ~2 veces lo que cuestan 100 mensajes. Al llegar, el bot también para.
 */
export const TRIAL_BUDGET_USD = 4;

/** Aviso único cuando la prueba gratis llega a este porcentaje de sus mensajes. */
export const TRIAL_WARN_PCT = 80;

/**
 * Precio fundador (07/10/2026): los primeros 50 negocios (los amigos de la beta) pagan 40 %
 * menos hasta `tenant.founder_until` (7 meses desde que se registran: la beta y 6 meses más).
 */
export const FOUNDER = { slots: 50, discountPct: 40, months: 7 } as const;

/** Fin del precio fundador para un negocio que se registra hoy: 7 meses después ("2027-05-07"). */
export function founderUntilFrom(today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  const end = new Date(Date.UTC(y ?? 2000, (m ?? 1) - 1 + FOUNDER.months, d ?? 1));
  return end.toISOString().slice(0, 10);
}

/** Aviso único cuando el uso del mes pasa este porcentaje del tope. */
export const CAP_WARN_PCT = 80;

/** Reglas de la suscripción (decididas por Javier el 02/10/2026). */
export const TRIAL_DAYS = 14;
export const GRACE_DAYS = 3;
export const PERIOD_DAYS = 30;
