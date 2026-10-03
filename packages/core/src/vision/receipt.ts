import { z } from "zod";
import type { LlmClient, LlmToolDef, LlmUsage } from "../agent/llm";
import { daysBetween, type IsoDate, isIsoDate } from "../domain/dates";
import { pagoMovilData } from "../domain/pago-movil";

/**
 * Lectura de facturas con el modelo de visión del LLM (US-B6, ADR-007): una llamada con la imagen
 * y una sola herramienta con esquema estricto. El modelo solo extrae; el backend decide.
 * Sin uniones en el esquema (tope de 16 en modo strict): "" y "unknown" para lo ausente.
 */
export const ReceiptExtraction = z.object({
  is_receipt: z.boolean(),
  total: z.string(),
  currency: z.enum(["USD", "VES", "unknown"]),
  date: z.string(),
  vendor: z.string(),
  line_items_count: z.number(),
  confidence: z.number(),
  /**
   * 03/10: un reporte de ventas del propio negocio es dinero que entró, no un gasto. `pago_movil`:
   * los datos de alguien a quien hay que pagar (banco, teléfono, cédula), todavía sin pagar.
   */
  document_type: z.enum(["expense", "sales", "pago_movil", "unknown"]).default("unknown"),
  /** Datos de pago móvil, solo con `document_type` pago_movil ("" en lo que no aplica). */
  payee: z
    .object({ bank: z.string(), phone: z.string(), id_number: z.string(), holder: z.string() })
    .optional(),
});
export type ReceiptExtraction = z.infer<typeof ReceiptExtraction>;

export const RECEIPT_MIN_CONFIDENCE = 0.6;

export const READ_RECEIPT_TOOL: LlmToolDef = {
  name: "read_receipt",
  description: "Devuelve lo que se lee en la imagen o el PDF de una factura o recibo.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: [
      "is_receipt",
      "total",
      "currency",
      "date",
      "vendor",
      "line_items_count",
      "confidence",
      "document_type",
      "payee",
    ],
    properties: {
      is_receipt: {
        type: "boolean",
        description:
          "true si la imagen o el PDF es una factura, recibo, ticket o comprobante de pago.",
      },
      total: {
        type: "string",
        description:
          'Total pagado tal como aparece, con IVA incluido, solo dígitos y separador decimal con punto (ej. "45.50"). "" si no se lee.',
      },
      currency: {
        type: "string",
        enum: ["USD", "VES", "unknown"],
        description:
          'Moneda del total: "$" o "USD" → USD; "Bs", "Bs.", "VES", "bolívares" → VES. "unknown" si no se ve.',
      },
      date: {
        type: "string",
        description:
          'Fecha de la factura en formato YYYY-MM-DD si es legible; "" si no. En Venezuela se escribe día/mes/año: "03/10/2026" es 2026-10-03.',
      },
      vendor: {
        type: "string",
        description: 'Nombre del comercio o proveedor; "" si no se lee.',
      },
      line_items_count: {
        type: "number",
        description: "Cantidad de renglones de productos; 0 si no aplica.",
      },
      confidence: {
        type: "number",
        description: "Confianza de 0 a 1 en el total y la moneda leídos.",
      },
      document_type: {
        type: "string",
        enum: ["expense", "sales", "pago_movil", "unknown"],
        description:
          '"sales" si registra dinero que el negocio del usuario RECIBIÓ (reporte, detalle o cierre de ventas; factura o recibo emitido POR el negocio del usuario a un cliente). "expense" si es algo que el negocio PAGÓ a otro comercio o proveedor (incluye el comprobante de un pago móvil ya hecho, con referencia). "pago_movil" si son los DATOS para hacer un pago móvil (banco, teléfono y cédula o RIF de quien cobra), sin pago hecho todavía. "unknown" si no se puede saber.',
      },
      payee: {
        type: "object",
        additionalProperties: false,
        required: ["bank", "phone", "id_number", "holder"],
        description:
          'Solo si document_type es "pago_movil": los datos de quien cobra, copiados tal como se ven. Si no, todos "".',
        properties: {
          bank: {
            type: "string",
            description:
              'Banco con su código si aparece ("0102 Banco de Venezuela", "Banesco"); "" si no se ve.',
          },
          phone: { type: "string", description: 'Teléfono del pago móvil; "" si no se ve.' },
          id_number: {
            type: "string",
            description: 'Cédula o RIF con su letra ("V-25871244", "J-401234567"); "" si no se ve.',
          },
          holder: { type: "string", description: 'Nombre del titular; "" si no se ve.' },
        },
      },
    },
  },
};

const RECEIPT_SYSTEM = [
  "Eres un lector de facturas y recibos de negocios en Venezuela. Recibes una imagen o un PDF y respondes SOLO con la herramienta read_receipt.",
  "Si es un PDF de varias páginas, el total suele estar en la última página de la factura; ignora páginas de términos, publicidad o anexos.",
  "El total es lo que se pagó, con IVA incluido. Si hay 'Total' y 'Subtotal', usa 'Total'.",
  "Montos venezolanos: el punto separa miles y la coma decimales (1.250,50 = 1250.50). Devuelve el total con punto decimal.",
  "Fechas: en Venezuela van día/mes/año (03/10/2026 = 3 de octubre de 2026 → 2026-10-03; 10/03/26 = 10 de marzo de 2026). Nunca las leas como mes/día.",
  "Moneda: Bs, Bs., BsS, VES o 'bolívares' es VES; $, USD o 'dólares' es USD. 'Ref' suele ser USD de referencia; si el pago fue en Bs, la moneda es VES.",
  "document_type: mira quién emite el documento. Si el emisor es el negocio del usuario (su nombre viene en el mensaje) o el título habla de ventas, cierre de caja o ingresos, es 'sales'. Si lo emite otro comercio y el negocio del usuario es el cliente, es 'expense'.",
  "Si la parte entera del total se lee clara pero los céntimos están cortados o borrosos (la foto cortó el borde), devuelve el total con los decimales que se vean (o sin decimales) y confianza 0.7: unos céntimos no cambian el gasto y el usuario confirma el borrador. Baja la confianza de 0.6 solo si no se lee algún dígito de la parte entera o la moneda.",
  "Datos de pago móvil (una nota, captura o cartel con banco, teléfono y cédula o RIF para que le paguen a alguien): is_receipt=false, document_type='pago_movil', copia cada dato en payee sin cambiar dígitos, y en total el monto a pagar si aparece (\"\" si no). Un comprobante de pago móvil YA hecho (operación exitosa, número de referencia) no es esto: es 'expense'.",
  "Si la imagen o el PDF no es una factura, recibo, ticket o comprobante (un contrato, un estado de cuenta, una cotización, un menú), is_receipt=false. No inventes cifras: si no se lee, deja el campo vacío y baja la confianza.",
].join("\n");

export type ReceiptReadResult = { extraction: ReceiptExtraction; usage: LlmUsage; costUsd: string };

export interface ReceiptReader {
  readonly provider: string;
  /** `businessName`: el negocio del usuario, para saber si el documento lo emitió él (venta). */
  read(
    image: Uint8Array,
    mimeType: string,
    opts?: { businessName?: string | null },
  ): Promise<ReceiptReadResult>;
}

const EMPTY: ReceiptExtraction = {
  is_receipt: false,
  total: "",
  currency: "unknown",
  date: "",
  vendor: "",
  line_items_count: 0,
  confidence: 0,
  document_type: "unknown",
  payee: { bank: "", phone: "", id_number: "", holder: "" },
};

export function createReceiptReader(llm: LlmClient): ReceiptReader {
  return {
    provider: llm.model,
    async read(image, mimeType, opts) {
      const what = mimeType === "application/pdf" ? "Lee este PDF." : "Lee esta imagen.";
      // El nombre va en el turno, no en el sistema: así el prompt de sistema sigue en caché.
      const who = opts?.businessName
        ? ` El negocio del usuario se llama "${opts.businessName}".`
        : "";
      const res = await llm.complete({
        system: [{ text: RECEIPT_SYSTEM, cache: true }],
        turns: [
          {
            role: "user",
            text: `${what}${who}`,
            image: { mimeType, data: image },
          },
        ],
        tools: [READ_RECEIPT_TOOL],
        maxTokens: 400,
        timeoutMs: 25_000,
      });
      const call = res.toolCalls.find((c) => c.name === READ_RECEIPT_TOOL.name);
      const parsed = call ? ReceiptExtraction.safeParse(call.input) : null;
      return {
        extraction: parsed?.success ? parsed.data : EMPTY,
        usage: res.usage,
        costUsd: llm.costUsd(res.usage).toFixed(6),
      };
    },
  };
}

/**
 * Lo que el agente recibe como "mensaje del usuario" tras leer la factura. Un reporte de ventas
 * va a la venta del día; la leyenda del archivo, si la hay, manda sobre lo que se infirió.
 */
export function receiptUserText(e: ReceiptExtraction, caption: string | null = null): string {
  const parts = [
    `total ${e.total || "no legible"} ${e.currency === "unknown" ? "(moneda no legible)" : e.currency}`,
    `fecha ${e.date || "no legible"}`,
    `${e.document_type === "sales" ? "emisor" : "proveedor"} ${e.vendor || "no legible"}`,
    `${e.line_items_count} renglones`,
  ];
  const note = caption?.trim()
    ? ` El usuario escribió junto al archivo: "${caption.trim().slice(0, 200)}". Si dice que es una venta o un gasto, eso manda sobre lo leído. Si dice qué se compró o en qué fue, úsalo como description, corto y sin verbos ("Registrar compra de cepillos y pala" → "Cepillos y pala"), y como category_name si encaja con una categoría.`
    : "";
  if (e.document_type === "pago_movil") {
    const cur = e.currency === "USD" ? "USD" : "VES";
    const desc = caption?.trim()
      ? "lo que dice la leyenda del usuario"
      : JSON.stringify(pagoMovilDescription(e));
    return `Datos de pago móvil leídos por el sistema: el usuario va a PAGAR ${e.total} ${cur}${e.payee?.holder ? ` a ${e.payee.holder}` : ""}. Déjalo listo como gasto con draft_expense: amount = ${e.total}, currency = ${cur}, when = "", category_name = "" salvo que la leyenda diga en qué es, description = ${desc}. No inventes datos que no estén.${note}`;
  }
  if (e.document_type === "sales")
    return `Reporte de ventas leído por el sistema: ${parts.join("; ")}. Es dinero que ENTRÓ: registra la venta del día con draft_income_day_total usando esos datos: total_amount = total, total_currency = moneda leída ("unknown" si no se ve), when = fecha leída ("" si no se ve), lines vacío. No inventes datos que no estén.${note}`;
  return `Factura leída por el sistema: ${parts.join("; ")}. Registra el gasto con draft_expense usando esos datos: amount = total, currency = moneda leída ("unknown" si no se ve), when = fecha leída ("" si no se ve), description = proveedor (o "Factura"). No inventes datos que no estén.${note}`;
}

/** "Pago móvil a Javier Ortiz" (o al banco si no se ve el titular). */
export function pagoMovilDescription(e: ReceiptExtraction): string {
  const d = e.payee ? pagoMovilData(e.payee) : null;
  const who = d?.holder ?? d?.bankName;
  return who ? `Pago móvil a ${who}` : "Pago móvil";
}

/**
 * Red de seguridad para la fecha leída (03/10): si quedó en el futuro o de hace más de un mes y con
 * día y mes al revés cae entre hoy y hace un mes, se leyó como mes/día. "2026-03-10" con hoy
 * 2026-10-03 → "2026-10-03". Si no, la deja como vino.
 */
export function fixDayMonth(date: string, today: IsoDate): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m || !isIsoDate(date)) return date;
  const inWindow = (d: IsoDate) => d <= today && daysBetween(d, today) <= 31;
  if (inWindow(date as IsoDate)) return date;
  const swapped = `${m[1]}-${m[3]}-${m[2]}`;
  return isIsoDate(swapped) && inWindow(swapped as IsoDate) ? swapped : date;
}
