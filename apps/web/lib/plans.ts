/**
 * Planes y límites (borrador del modelo de negocio, `docs/MODELO-NEGOCIO.md`). Una sola fuente
 * para la landing y, más adelante, para el control de cupo por tenant. Los precios son hipótesis
 * hasta cerrar el piloto; se cambian aquí y la landing los refleja.
 */
export type Plan = {
  id: "personal" | "negocio" | "negocio_plus";
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
    priceUsd: 4.99,
    tagline: "Tus gastos de todos los días, sin abrir una app.",
    messagesPerMonth: 150,
    numbers: 1,
    employees: 0,
    features: [
      "1 número de WhatsApp",
      "150 registros al mes (unos 5 al día)",
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
    tagline: "La caja de un negocio pequeño: tú y una persona más.",
    messagesPerMonth: 600,
    numbers: 2,
    employees: 1,
    features: [
      "Tu número + 1 empleado",
      "600 registros al mes (unos 20 al día)",
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
    tagline: "Varios turnos o varias personas registrando.",
    messagesPerMonth: 1500,
    numbers: 4,
    employees: 3,
    features: [
      "Tu número + 3 empleados",
      "1.500 registros al mes",
      "Todo lo del plan Negocio",
      "Soporte por WhatsApp en horario de oficina",
    ],
  },
];

export const PILOT_NOTE =
  "Durante el piloto no se cobra. Los precios de arriba son los que se activarán al salir del piloto, y se avisan con 30 días de anticipación.";
