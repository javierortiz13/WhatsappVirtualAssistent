import { z } from "zod";
import type { LlmClient, LlmToolDef, LlmUsage } from "../agent/llm";
import { Decimal, parseVenezuelanAmount } from "../domain/money";
import type { Bill, SplitAssignment } from "../domain/split";

/**
 * Dividir la cuenta (06/10): dos llamadas al mismo modelo, cada una con una sola herramienta
 * estricta. `readBill` lee los renglones de la factura; `assign` traduce lo que escribió el
 * usuario ("yo la pizza y el refresco, Pedro la hamburguesa") a índices de renglones. La cuenta
 * la hace `computeSplit`.
 */
const BillRead = z.object({
  is_bill: z.boolean(),
  vendor: z.string(),
  currency: z.enum(["USD", "VES", "unknown"]),
  items: z.array(z.object({ name: z.string(), quantity: z.number(), amount: z.string() })),
  total: z.string(),
  confidence: z.number(),
});

const READ_BILL_TOOL: LlmToolDef = {
  name: "read_bill",
  description: "Devuelve los renglones de consumo y el total de una factura, cuenta o ticket.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["is_bill", "vendor", "currency", "items", "total", "confidence"],
    properties: {
      is_bill: {
        type: "boolean",
        description: "true si es una factura, cuenta, comanda o ticket con renglones de consumo.",
      },
      vendor: { type: "string", description: 'Nombre del comercio; "" si no se lee.' },
      currency: {
        type: "string",
        enum: ["USD", "VES", "unknown"],
        description: '"$"/USD/Ref → USD; Bs/VES → VES; "unknown" si no se ve.',
      },
      items: {
        type: "array",
        description:
          "Cada renglón de consumo en el orden de la factura. No incluyas subtotal, IVA, servicio, propina ni total.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "quantity", "amount"],
          properties: {
            name: { type: "string", description: "Producto tal como se lee, corto." },
            quantity: { type: "number", description: "Cantidad (1 si no aparece)." },
            amount: {
              type: "string",
              description:
                'Importe TOTAL del renglón (cantidad × precio), con punto decimal y sin separador de miles ("12.50").',
            },
          },
        },
      },
      total: {
        type: "string",
        description:
          'Total a pagar con IVA, servicio y propina si aparecen, con punto decimal; "" si no se lee.',
      },
      confidence: { type: "number", description: "Confianza de 0 a 1 en los renglones leídos." },
    },
  },
};

const READ_BILL_SYSTEM = [
  "Lees facturas, cuentas de restaurante y tickets en Venezuela para dividir la cuenta entre varias personas. Respondes SOLO con la herramienta read_bill.",
  "Copia cada renglón de consumo con su cantidad y su importe total (cantidad por precio). No sumes ni inventes: si un renglón no se lee, déjalo fuera y baja la confianza.",
  "Montos venezolanos: el punto separa miles y la coma decimales (1.250,50 = 1250.50). Devuélvelos con punto decimal.",
  "Subtotal, IVA, servicio (10 %), propina, descuentos y total NO son renglones: el total va en total.",
].join("\n");

const Assign = z.object({
  is_assignment: z.boolean(),
  people: z.array(
    z.object({
      name: z.string(),
      is_me: z.boolean(),
      items: z.array(z.object({ index: z.number(), units: z.number() })),
    }),
  ),
  shared_by_all: z.array(z.number()),
  equal_split: z.number(),
});

const ASSIGN_TOOL: LlmToolDef = {
  name: "assign_bill",
  description: "Reparte los renglones numerados de la cuenta entre las personas que nombra.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["is_assignment", "people", "shared_by_all", "equal_split"],
    properties: {
      is_assignment: {
        type: "boolean",
        description:
          "true si el texto dice quién consumió qué o pide partes iguales; false si habla de otra cosa o solo pide dividir sin decir cómo.",
      },
      people: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "is_me", "items"],
          properties: {
            name: {
              type: "string",
              description:
                'Nombre como lo escribió ("Pedro"); "Tú" para quien escribe (yo, mío, me).',
            },
            is_me: { type: "boolean", description: "true si es quien escribe (yo, mío, me)." },
            items: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["index", "units"],
                properties: {
                  index: { type: "number", description: "Número del renglón (1..N)." },
                  units: {
                    type: "number",
                    description:
                      "Unidades que consumió si lo dice ('2 de las cervezas' → 2); 0 si es el renglón entero o compartido.",
                  },
                },
              },
            },
          },
        },
      },
      shared_by_all: {
        type: "array",
        items: { type: "number" },
        description:
          "Renglones que se reparten entre todos ('el resto entre todos', 'las bebidas a medias entre todos').",
      },
      equal_split: {
        type: "number",
        description:
          "Si pide partes iguales entre N personas ('entre 4', 'a partes iguales los 3'), N; si no, 0.",
      },
    },
  },
};

const ASSIGN_SYSTEM = [
  "Recibes la lista numerada de una cuenta y lo que escribió el usuario. Arma quién consumió qué con la herramienta assign_bill.",
  "Quien escribe es 'Tú' (is_me true): 'yo', 'lo mío', 'me comí', 'mi parte'.",
  "Empareja cada plato que nombra con el renglón más parecido de la lista (sin importar mayúsculas, tildes o plurales). Si nombra algo que no está en la lista, no lo inventes.",
  "Si un renglón lo comparten varios ('la pizza a medias con Pedro', 'el refresco entre los 3'), ponlo en la lista de cada uno con units 0.",
  "Si dice cuántas unidades de un renglón con cantidad mayor a 1 ('yo 2 cervezas' y el renglón es 3 cervezas), units es esa cantidad.",
  "'Lo demás' o 'el resto entre todos' son los renglones que nadie nombró: van en shared_by_all.",
  "'Divídelo entre 4' o 'a partes iguales' sin decir quién comió qué: equal_split con ese número y people vacío.",
].join("\n");

export type BillReadResult = {
  bill: Bill | null;
  confidence: number;
  usage: LlmUsage;
  costUsd: string;
};
export type AssignResult = {
  assignment: SplitAssignment | null;
  usage: LlmUsage;
  costUsd: string;
};

export interface BillReader {
  readBill(image: Uint8Array, mimeType: string): Promise<BillReadResult>;
  assign(bill: Bill, text: string): Promise<AssignResult>;
}

const amount = (s: string): Decimal | null => {
  const t = s.trim();
  if (!t) return null;
  const d = /^\d+(\.\d+)?$/.test(t) ? new Decimal(t) : parseVenezuelanAmount(t);
  return d?.isFinite() && d.gt(0) ? d : null;
};

/** Lista numerada que ve el modelo al repartir: "1. Pizza margarita ×1 — 12.50". */
export function billLines(bill: Bill): string {
  return bill.items
    .map(
      (i, k) =>
        `${k + 1}. ${i.name}${i.quantity > 1 ? ` ×${i.quantity}` : ""} — ${i.amount.toFixed(2)}`,
    )
    .join("\n");
}

export function createBillReader(llm: LlmClient): BillReader {
  return {
    async readBill(image, mimeType) {
      const res = await llm.complete({
        system: [{ text: READ_BILL_SYSTEM, cache: true }],
        turns: [{ role: "user", text: "Lee esta cuenta.", image: { mimeType, data: image } }],
        tools: [READ_BILL_TOOL],
        maxTokens: 1500,
        timeoutMs: 30_000,
      });
      const call = res.toolCalls.find((c) => c.name === READ_BILL_TOOL.name);
      const parsed = call ? BillRead.safeParse(call.input) : null;
      const costUsd = llm.costUsd(res.usage).toFixed(6);
      if (!parsed?.success || !parsed.data.is_bill)
        return { bill: null, confidence: 0, usage: res.usage, costUsd };
      const d = parsed.data;
      const items = d.items.flatMap((i) => {
        const a = amount(i.amount);
        return a && i.name.trim()
          ? [
              {
                name: i.name.trim().slice(0, 60),
                quantity: Math.max(1, Math.round(i.quantity) || 1),
                amount: a,
              },
            ]
          : [];
      });
      if (!items.length) return { bill: null, confidence: 0, usage: res.usage, costUsd };
      const total = amount(d.total);
      const sum = items.reduce((s, i) => s.plus(i.amount), new Decimal(0));
      const currency =
        d.currency !== "unknown" ? d.currency : (total ?? sum).gte(1000) ? "VES" : "USD";
      return {
        bill: { vendor: d.vendor.trim().slice(0, 60), currency, items, total },
        confidence: d.confidence,
        usage: res.usage,
        costUsd,
      };
    },
    async assign(bill, text) {
      const res = await llm.complete({
        system: [{ text: ASSIGN_SYSTEM, cache: true }],
        turns: [
          {
            role: "user",
            text: `Cuenta:\n${billLines(bill)}\n\nLo que escribió el usuario: "${text.slice(0, 600)}"`,
          },
        ],
        tools: [ASSIGN_TOOL],
        maxTokens: 800,
        timeoutMs: 20_000,
      });
      const call = res.toolCalls.find((c) => c.name === ASSIGN_TOOL.name);
      const parsed = call ? Assign.safeParse(call.input) : null;
      const costUsd = llm.costUsd(res.usage).toFixed(6);
      if (!parsed?.success || !parsed.data.is_assignment)
        return { assignment: null, usage: res.usage, costUsd };
      const d = parsed.data;
      return {
        assignment: {
          people: d.people.map((p) => ({
            name: (p.is_me ? "Tú" : p.name.trim() || "Alguien").slice(0, 30),
            isMe: p.is_me,
            items: p.items.map((x) => ({
              index: Math.round(x.index),
              units: Math.max(0, x.units),
            })),
          })),
          sharedByAll: d.shared_by_all.map((i) => Math.round(i)),
          equalSplit: Math.max(0, Math.round(d.equal_split)),
        },
        usage: res.usage,
        costUsd,
      };
    },
  };
}
