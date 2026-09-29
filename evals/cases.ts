import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

/**
 * Formato de un caso de eval (Fase 8). Cada archivo YAML en `cases/` es una lista de casos.
 * `tool` es la herramienta esperada; `tool_not` la que NO debe elegirse. `args` compara un
 * subconjunto: `amount` como número, `when` como fecha resuelta, el resto exacto.
 */
export const EvalCase = z.object({
  name: z.string(),
  input: z.string(),
  role: z.enum(["owner", "employee"]).default("owner"),
  default_currency: z.enum(["USD", "VES"]).nullable().default("USD"),
  expect: z.object({
    tool: z.string().optional(),
    tool_not: z.string().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    reply_contains: z.array(z.string()).optional(),
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
    return list.map((c) => ({ ...c, name: `${f.replace(/\.ya?ml$/, "")} › ${c.name}` }));
  });
}
