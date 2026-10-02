import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/**
 * Formato de un caso de eval (Fase 8). Cada archivo YAML en `cases/` es una lista de casos.
 * `tool` es la herramienta esperada; `tool_not` la que NO debe elegirse. `args` compara un
 * subconjunto: `amount` como número, `when` como fecha resuelta, el resto exacto.
 */
const Receipt = z.object({
  is_receipt: z.boolean().default(true),
  total: z.string().default(""),
  currency: z.enum(["USD", "VES", "unknown"]).default("unknown"),
  date: z.string().default(""),
  vendor: z.string().default(""),
  line_items_count: z.number().int().default(0),
  confidence: z.number().default(0.9),
});

/**
 * v1 (S2): `kind: voice` manda el mismo texto como transcripción; `receipt` sustituye al texto
 * por la lectura de una factura; `history` son los turnos previos de los últimos minutos (lo que
 * el usuario escribió y lo que el bot respondió), como los ve el agente en producción. Así se
 * prueban las respuestas a los botones de moneda y categoría, que vuelven como texto.
 */
export const EvalCase = z.object({
  name: z.string(),
  input: z.string().default(""),
  kind: z.enum(["text", "voice"]).default("text"),
  receipt: Receipt.optional(),
  history: z.array(z.object({ role: z.enum(["in", "out"]), body: z.string() })).default([]),
  /**
   * Borradores de gasto que esperan su Guardar antes del mensaje (cola de borradores, 02/10), el
   * más viejo primero. `fixing: true` simula que el usuario tocó Corregir en ese borrador.
   */
  pending: z
    .array(
      z.object({
        amount: z.string(),
        currency: z.enum(["USD", "VES"]).default("USD"),
        description: z.string(),
        category: z.string().default("Otros"),
        fixing: z.boolean().default(false),
      }),
    )
    .default([]),
  role: z.enum(["owner", "employee"]).default("owner"),
  default_currency: z.enum(["USD", "VES"]).nullable().default("USD"),
  expect: z.object({
    tool: z.string().optional(),
    tool_not: z.string().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    reply_contains: z.array(z.string()).optional(),
    /** Lo que importa es el resultado: no debe quedar ningún borrador, elija lo que elija el modelo. */
    no_draft: z.boolean().optional(),
    /** Borradores pendientes que deben quedar después del turno (cola de borradores). */
    pending_after: z.number().int().optional(),
  }),
});
export type EvalCase = z.infer<typeof EvalCase>;

export function loadCases(dir = join(import.meta.dirname, "cases")): EvalCase[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();
  return files.flatMap((f) => {
    const raw = parse(readFileSync(join(dir, f), "utf8")) as unknown;
    const list = z.array(EvalCase).parse(raw);
    for (const c of list)
      if (!c.input && !c.receipt)
        throw new Error(`${f}: el caso "${c.name}" no tiene input ni receipt`);
    return list.map((c) => ({ ...c, name: `${f.replace(/\.ya?ml$/, "")} › ${c.name}` }));
  });
}
