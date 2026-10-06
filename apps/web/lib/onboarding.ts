/**
 * Datos de presentación del onboarding (05/10/2026): íconos y colores de categorías, plantillas
 * de cuentas y tipos de negocio. Solo se ven en la web; el bot no los usa.
 */

/** Ícono (emoji) para una categoría por su nombre; las propias del usuario caen en 🏷️. */
const CATEGORY_ICONS: [RegExp, string][] = [
  [/lavado|champ|cera/, "🧴"],
  [/agua|electric|luz|servicios basicos|gas y elec/, "💡"],
  [/casa/, "🏠"],
  [/mantenimiento|reparac/, "🔧"],
  [/nomina|personal y|ayudantes|contratistas/, "👥"],
  [/alquiler/, "🏢"],
  [/gasolina/, "⛽"],
  [/transporte|fletes/, "🚗"],
  [/comida fuera|comida del personal|restaurant/, "🍽️"],
  [/publicidad|redes/, "📣"],
  [/impuestos|tramites/, "🧾"],
  [/ingredientes|mercado/, "🛒"],
  [/mercancia/, "📦"],
  [/empaques/, "🥡"],
  [/equipos|utensilios|herramientas|materiales/, "🛠️"],
  [/delivery/, "🛵"],
  [/insumos/, "🧪"],
  [/salud|farmacia|medic/, "💊"],
  [/educacion|colegio|curso/, "📚"],
  [/entretenimiento|salidas/, "🎬"],
  [/ropa|cuidado/, "👕"],
  [/suscripciones|streaming/, "📺"],
  [/internet|telefono/, "📶"],
  [/mascotas/, "🐾"],
  [/regalos/, "🎁"],
  [/viajes/, "✈️"],
  [/seguros/, "🛡️"],
  [/^otros$/, "📌"],
];

/** Colores de fondo suaves, uno por categoría en orden (como las tarjetas de Rial). */
export const TILE_COLORS = [
  "#3fe0b0",
  "#6cb6ff",
  "#f5b04c",
  "#b79cff",
  "#ff8fa3",
  "#5fd3f3",
  "#ffd166",
  "#9be15d",
  "#ff9f6e",
  "#c3a6ff",
] as const;

const plain = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export function categoryIcon(name: string): string {
  const p = plain(name);
  return CATEGORY_ICONS.find(([re]) => re.test(p))?.[1] ?? "🏷️";
}

export type AccountTemplate = {
  id: string;
  label: string;
  hint: string;
  icon: string;
  name: string;
  currency: "USD" | "VES";
  kind: "bank" | "cash" | "zelle" | "crypto" | "other";
  unit: string;
};

/** Las cuentas más comunes en Venezuela, para crearlas con un toque. */
export const ACCOUNT_TEMPLATES: AccountTemplate[] = [
  {
    id: "bank_ves",
    label: "Banco en Bs",
    hint: "Pago móvil, punto, transferencias",
    icon: "🏦",
    name: "Banco",
    currency: "VES",
    kind: "bank",
    unit: "Bs",
  },
  {
    id: "binance",
    label: "Binance",
    hint: "Tus USDT",
    icon: "🪙",
    name: "Binance",
    currency: "USD",
    kind: "crypto",
    unit: "USDT",
  },
  {
    id: "zelle",
    label: "Zelle",
    hint: "Dólares en cuenta",
    icon: "💳",
    name: "Zelle",
    currency: "USD",
    kind: "zelle",
    unit: "$",
  },
  {
    id: "cash_usd",
    label: "Efectivo $",
    hint: "Los verdes en mano",
    icon: "💵",
    name: "Efectivo $",
    currency: "USD",
    kind: "cash",
    unit: "$",
  },
  {
    id: "cash_ves",
    label: "Efectivo Bs",
    hint: "Billetes en bolívares",
    icon: "💴",
    name: "Efectivo Bs",
    currency: "VES",
    kind: "cash",
    unit: "Bs",
  },
];

export const BUSINESS_TYPE_ICONS: Record<string, string> = {
  car_wash: "🚗",
  food: "🍔",
  retail: "🛒",
  services: "🛠️",
  other: "💼",
  personal: "🙋",
};

/** Lo que el asistente sabe hacer, con un ejemplo para escribirle. */
export const BOT_FEATURES = [
  { icon: "💸", title: "Gastos y ventas", example: "gasté 15$ en champú" },
  { icon: "🎙️", title: "Notas de voz", example: "Mándale un audio y lo anota" },
  { icon: "🧾", title: "Fotos de facturas", example: "Envía la foto y arma el gasto" },
  { icon: "📊", title: "Cierres y resúmenes", example: "cómo va el mes" },
  { icon: "💱", title: "Tasa y calculadora", example: "suma 12.030 + 26.171 en $" },
  { icon: "🍕", title: "Dividir la cuenta", example: "Foto + dividir: yo la pizza, Pedro…" },
  { icon: "💳", title: "Cuentas y saldos", example: "mis cuentas" },
] as const;
