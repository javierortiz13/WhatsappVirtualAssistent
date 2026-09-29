/**
 * Categorías de gasto por defecto por tipo de negocio (Fase 4). Máximo 10 por tipo para que
 * quepan en una lista de WhatsApp. "Otros" siempre existe y no se puede desactivar.
 * Títulos de fila de lista: máximo 24 caracteres.
 */
export const DEFAULT_EXPENSE_CATEGORIES: Record<string, readonly string[]> = {
  car_wash: [
    "Insumos de lavado",
    "Agua y electricidad",
    "Mantenimiento de equipos",
    "Nómina y personal",
    "Alquiler",
    "Transporte y gasolina",
    "Comida del personal",
    "Publicidad",
    "Impuestos y trámites",
    "Otros",
  ],
  food: [
    "Ingredientes",
    "Empaques",
    "Gas y electricidad",
    "Equipos y utensilios",
    "Delivery y transporte",
    "Publicidad y redes",
    "Nómina y ayudantes",
    "Alquiler",
    "Impuestos y trámites",
    "Otros",
  ],
  retail: [
    "Mercancía",
    "Alquiler",
    "Servicios básicos",
    "Nómina",
    "Transporte y fletes",
    "Mantenimiento",
    "Publicidad",
    "Impuestos y trámites",
    "Otros",
  ],
  services: [
    "Materiales y herramientas",
    "Transporte",
    "Nómina y contratistas",
    "Alquiler",
    "Servicios básicos",
    "Publicidad",
    "Equipos",
    "Impuestos y trámites",
    "Otros",
  ],
  other: [
    "Insumos",
    "Alquiler",
    "Servicios básicos",
    "Nómina",
    "Transporte",
    "Mantenimiento",
    "Publicidad",
    "Impuestos y trámites",
    "Otros",
  ],
};

export const OTHERS_CATEGORY = "Otros";
export const MAX_ACTIVE_CATEGORIES = 10;
export const MAX_CATEGORY_NAME_LENGTH = 24;
