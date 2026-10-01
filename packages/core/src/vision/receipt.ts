import { z } from "zod";
import type { LlmClient, LlmToolDef, LlmUsage } from "../agent/llm";

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
});
export type ReceiptExtraction = z.infer<typeof ReceiptExtraction>;

export const RECEIPT_MIN_CONFIDENCE = 0.6;

export const READ_RECEIPT_TOOL: LlmToolDef = {
  name: "read_receipt",
  description: "Devuelve lo que se lee en la imagen de una factura o recibo.",
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
    ],
    properties: {
      is_receipt: {
        type: "boolean",
        description: "true si la imagen es una factura, recibo, ticket o comprobante de pago.",
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
        description: 'Fecha de la factura en formato YYYY-MM-DD si es legible; "" si no.',
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
    },
  },
};

const RECEIPT_SYSTEM = [
  "Eres un lector de facturas y recibos de negocios en Venezuela. Recibes una imagen y respondes SOLO con la herramienta read_receipt.",
  "El total es lo que se pagó, con IVA incluido. Si hay 'Total' y 'Subtotal', usa 'Total'.",
  "Montos venezolanos: el punto separa miles y la coma decimales (1.250,50 = 1250.50). Devuelve el total con punto decimal.",
  "Moneda: Bs, Bs., BsS, VES o 'bolívares' es VES; $, USD o 'dólares' es USD. 'Ref' suele ser USD de referencia; si el pago fue en Bs, la moneda es VES.",
  "Si la imagen no es una factura, recibo, ticket o comprobante, is_receipt=false. No inventes cifras: si no se lee, deja el campo vacío y baja la confianza.",
].join("\n");

export type ReceiptReadResult = { extraction: ReceiptExtraction; usage: LlmUsage; costUsd: string };

export interface ReceiptReader {
  readonly provider: string;
  read(image: Uint8Array, mimeType: string): Promise<ReceiptReadResult>;
}

const EMPTY: ReceiptExtraction = {
  is_receipt: false,
  total: "",
  currency: "unknown",
  date: "",
  vendor: "",
  line_items_count: 0,
  confidence: 0,
};

export function createReceiptReader(llm: LlmClient): ReceiptReader {
  return {
    provider: llm.model,
    async read(image, mimeType) {
      const res = await llm.complete({
        system: [{ text: RECEIPT_SYSTEM, cache: true }],
        turns: [{ role: "user", text: "Lee esta imagen.", image: { mimeType, data: image } }],
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

/** Lo que el agente recibe como "mensaje del usuario" tras leer la factura. */
export function receiptUserText(e: ReceiptExtraction): string {
  const parts = [
    `total ${e.total || "no legible"} ${e.currency === "unknown" ? "(moneda no legible)" : e.currency}`,
    `fecha ${e.date || "no legible"}`,
    `proveedor ${e.vendor || "no legible"}`,
    `${e.line_items_count} renglones`,
  ];
  return `Foto de factura leída por el sistema: ${parts.join("; ")}. Registra el gasto con draft_expense usando esos datos: amount = total, currency = moneda leída ("unknown" si no se ve), when = fecha leída ("" si no se ve), description = proveedor (o "Factura"). No inventes datos que no estén.`;
}
