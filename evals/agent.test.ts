import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentContext,
  type AgentInput,
  type AgentResult,
  AnthropicLlmClient,
  addDays,
  createAgent,
  Decimal,
  resolveWhen,
  todayInCaracas,
} from "@caja/core";
import { eq, loadNearestEnvFile, schema, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type EvalCase, loadCases } from "./cases";

/**
 * Evals v1 (Fase 8, día 5 y S2): los casos de `cases/*.yaml` contra el LLM real. Se corren solo con
 * `RUN_EVALS=1` y `ANTHROPIC_API_KEY`. Tope de costo por ejecución: `EVALS_MAX_USD` (0.50).
 * Escribe `report/last.json` con herramienta, argumentos, tokens, costo y latencia por caso.
 */
loadNearestEnvFile(import.meta.dirname);
const enabled = process.env.RUN_EVALS === "1" && Boolean(process.env.ANTHROPIC_API_KEY);
if (process.env.RUN_EVALS === "1" && !enabled)
  console.warn("evals: falta ANTHROPIC_API_KEY en el entorno o en el .env de la raíz; se saltan.");
const maxUsd = new Decimal(process.env.EVALS_MAX_USD ?? "0.50");
const cases = loadCases();

type Row = {
  name: string;
  ok: boolean;
  tool: string | null;
  args: unknown;
  reply: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: string;
  ms: number;
  error?: string;
};

describe.skipIf(!enabled)("evals v1 del agente", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  let base: AgentContext;
  const rows: Row[] = [];
  let spent = new Decimal(0);
  const today = todayInCaracas();
  // Las evals mandan turnos seguidos: el caché de 5 minutos basta y escribe más barato.
  const llm = new AnthropicLlmClient({
    model: process.env.EVALS_MODEL ?? "claude-sonnet-5-5",
    cacheTtl: "5m",
  });
  const agent = createAgent({ llm });

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Autolavado El Rápido",
      businessType: "car_wash",
      ownerPhone: "584121234567",
    });
    const { phone, cats } = await withTenant(t.db, tenantId, async (tx) => ({
      phone: await tx.select().from(schema.phoneNumber),
      cats: await tx
        .select({ id: schema.category.id, name: schema.category.name })
        .from(schema.category)
        .orderBy(schema.category.sortOrder),
    }));
    await t.db.insert(schema.bcvRate).values(
      Array.from({ length: 10 }, (_, i) => ({
        effectiveDate: addDays(today, -i),
        rate: "858.00000000",
        source: "test",
      })),
    );
    base = {
      tenantId,
      tenantName: "Autolavado El Rápido",
      phoneId: phone[0]?.id as string,
      role: "owner",
      defaultCurrency: "USD",
      vesThreshold: "1000",
      categories: cats,
      today,
      sourceMessageDbId: null,
      attachmentId: null,
      sourceChannel: "text",
      dashboardUrl: "https://caja.test",
    };
  });

  afterAll(async () => {
    await t?.close();
    const passed = rows.filter((r) => r.ok).length;
    const report = {
      model: llm.model,
      today,
      passed,
      total: rows.length,
      costUsd: spent.toFixed(6),
      rows,
    };
    const dir = join(import.meta.dirname, "report");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "last.json"), JSON.stringify(report, null, 2));
    console.log(
      `\nevals: ${passed}/${rows.length} · costo ${spent.toFixed(4)} USD · ${llm.model}\n` +
        rows
          .map((r) => `${r.ok ? "✓" : "✗"} ${r.name} → ${r.tool ?? "(sin tool)"} ${r.ms}ms`)
          .join("\n"),
    );
  });

  for (const c of cases) {
    it(c.name, async () => {
      if (spent.gte(maxUsd)) throw new Error(`tope de costo alcanzado: ${spent.toFixed(4)} USD`);
      const ctx: AgentContext = {
        ...base,
        role: c.role,
        defaultCurrency: c.default_currency,
        sourceChannel: c.receipt ? "image" : c.kind,
      };
      const started = Date.now();
      let result: AgentResult & { drafts: number };
      try {
        result = await withTenant(t.db, tenantId, async (tx) => {
          await tx.delete(schema.pendingAction);
          await tx.delete(schema.message);
          // Historial reciente: un turno por fila, en orden, dentro de la ventana de 30 minutos.
          const t0 = Date.now() - 60_000 * c.history.length;
          for (const [i, h] of c.history.entries()) {
            await tx.insert(schema.message).values({
              tenantId,
              phoneId: ctx.phoneId,
              direction: h.role,
              kind: "text",
              body: h.body,
              createdAt: new Date(t0 + i * 60_000),
            });
          }
          for (const [i, d] of c.pending.entries()) {
            await tx.insert(schema.pendingAction).values({
              tenantId,
              phoneId: ctx.phoneId,
              kind: "create_expense",
              payload: {
                amount: d.amount,
                currency: d.currency,
                description: d.description,
                categoryName: d.category,
                businessDate: ctx.today,
                attachmentId: null,
                ...(d.fixing ? { fixing: true } : {}),
              },
              expiresAt: new Date(Date.now() + 10 * 60_000),
              createdAt: new Date(Date.now() - 60_000 * (c.pending.length - i)),
            });
          }
          const input: AgentInput = c.receipt
            ? { kind: "receipt", extracted: c.receipt, caption: c.caption ?? null }
            : { kind: c.kind, text: c.input, afterUnclearReceipt: c.after_unclear_receipt ?? null };
          const r = await agent.run(tx, ctx, input);
          const drafts = await tx
            .select({ id: schema.pendingAction.id })
            .from(schema.pendingAction)
            .where(eq(schema.pendingAction.status, "pending"));
          return { ...r, drafts: drafts.length };
        });
      } catch (err) {
        rows.push({
          name: c.name,
          ok: false,
          tool: null,
          args: null,
          reply: "",
          tokensIn: 0,
          tokensOut: 0,
          costUsd: "0",
          ms: Date.now() - started,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      spent = spent.plus(result.costUsd ?? 0);
      const last = result.toolCalls[result.toolCalls.length - 1] ?? null;
      const reply = result.outbound.map((o) => ("body" in o ? o.body : "")).join("\n");
      const row: Row = {
        name: c.name,
        ok: false,
        tool: last?.name ?? null,
        args: last?.args ?? null,
        reply,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        costUsd: result.costUsd ?? "0",
        ms: Date.now() - started,
      };
      rows.push(row);
      try {
        check(c, last, reply, ctx, result.drafts);
        row.ok = true;
      } catch (err) {
        row.error = err instanceof Error ? err.message : String(err);
        throw err;
      }
    });
  }
});

function check(
  c: EvalCase,
  last: { name: string; args: unknown } | null,
  reply: string,
  ctx: AgentContext,
  drafts: number,
) {
  if (c.expect.no_draft) expect(drafts, `borradores tras "${c.input}"`).toBe(0);
  if (c.expect.pending_after !== undefined)
    expect(drafts, `borradores pendientes tras "${c.input}"`).toBe(c.expect.pending_after);
  if (c.expect.tool) expect(last?.name, `herramienta para "${c.input}"`).toBe(c.expect.tool);
  if (c.expect.tool_not) expect(last?.name).not.toBe(c.expect.tool_not);
  if (c.expect.args) {
    const args = (last?.args ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(c.expect.args)) {
      if (k === "amount") {
        // "" significa "sin monto" (ausente o sin cambio); solo compara numéricamente si ambos lo traen.
        const got = String(args.amount ?? "").trim();
        const want = String(v ?? "").trim();
        if (got === "" || want === "") expect(got, `amount ${args.amount}`).toBe(want);
        else expect(new Decimal(got).eq(new Decimal(want)), `amount ${args.amount}`).toBe(true);
      } else if (k === "when") {
        const got = resolveWhen((args.when as string | null) ?? null, ctx.today);
        const want = resolveWhen((v as string | null) ?? null, ctx.today);
        expect(got, `when ${args.when}`).toEqual(want);
      } else if (k === "item_currencies") {
        // draft_expenses: la moneda de cada ítem, en orden (las descripciones varían entre corridas).
        const items = (args.items ?? []) as { currency?: string }[];
        expect(
          items.map((i) => i.currency),
          "monedas de los ítems",
        ).toEqual(v);
      } else {
        expect(args[k], `arg ${k}`).toEqual(v);
      }
    }
  }
  for (const s of c.expect.reply_contains ?? []) expect(reply).toContain(s);
}
