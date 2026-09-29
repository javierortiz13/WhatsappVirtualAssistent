import { and, desc, eq, gt, schema, type Tx } from "@caja/db";
import type { z } from "zod";
import { type Logger, silentLogger } from "../log";
import { es } from "../render/index";
import { type LlmClient, type LlmTurn, LlmUnavailableError } from "./llm";
import { GLOBAL_SYSTEM, tenantSystem, userTurn } from "./prompt";
import { pendingDraftFor, type ToolSpec, toLlmToolDef, toolsForRole } from "./tools";
import type { AgentContext, AgentInput, AgentResult, AgentRunner } from "./types";

/**
 * Loop de tool-calling (Fase 3, ADR-005). El modelo solo elige herramienta y argumentos; el
 * texto al usuario lo produce `render` desde el resultado. Guardrails en orden:
 * rol → subconjunto de herramientas; sin tool_call → fuera de alcance; args inválidos → un
 * reintento; máximo 3 iteraciones; timeout por llamada; validación de cifras en aclaraciones.
 */
export type AgentOptions = {
  llm: LlmClient;
  maxIterations?: number;
  timeoutMs?: number;
  maxTokens?: number;
  historyLimit?: number;
  historyWindowMs?: number;
  log?: Logger;
  now?: () => Date;
};

export function createAgent(opts: AgentOptions): AgentRunner {
  const log = opts.log ?? silentLogger;
  const maxIterations = opts.maxIterations ?? 3;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxTokens = opts.maxTokens ?? 1024;
  const now = opts.now ?? (() => new Date());

  return {
    async run(tx: Tx, ctx: AgentContext, input: AgentInput): Promise<AgentResult> {
      const started = now();
      const tools = toolsForRole(ctx.role);
      const defs = tools.map(toLlmToolDef);
      const byName = new Map(tools.map((t) => [t.name, t]));
      const userText = input.kind === "text" ? input.text : JSON.stringify(input.extracted);

      const pending = await pendingDraftFor(tx, ctx.phoneId);
      const FIXABLE: Record<string, string> = {
        create_expense: "draft_expense",
        create_income_day_total: "draft_income_day_total",
        create_income_single: "draft_income_single",
      };
      const pendingDraft =
        pending && FIXABLE[pending.kind] && (pending.payload as { fixing?: boolean }).fixing
          ? {
              tool: FIXABLE[pending.kind] as string,
              payload: pending.payload as Record<string, unknown>,
            }
          : null;
      const history = await recentHistory(
        tx,
        ctx.phoneId,
        opts.historyLimit ?? 10,
        new Date(started.getTime() - (opts.historyWindowMs ?? 30 * 60_000)),
      );

      const turns: LlmTurn[] = [
        ...history,
        { role: "user", text: userTurn(userText, ctx.today, pendingDraft) },
      ];
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      const toolCalls: AgentResult["toolCalls"] = [];
      let invalidRetries = 0;

      const finish = (
        outbound: AgentResult["outbound"],
        status: AgentResult["status"],
      ): AgentResult => ({
        outbound,
        toolCalls,
        tokensIn: usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
        tokensOut: usage.outputTokens,
        costUsd: opts.llm.costUsd(usage).toFixed(6),
        status,
      });

      for (let i = 0; i < maxIterations; i++) {
        const res = await opts.llm.complete({
          system: [
            { text: GLOBAL_SYSTEM, cache: true },
            { text: tenantSystem(ctx), cache: true },
          ],
          turns,
          tools: defs,
          maxTokens,
          timeoutMs,
        });
        usage.inputTokens += res.usage.inputTokens;
        usage.outputTokens += res.usage.outputTokens;
        usage.cacheReadTokens += res.usage.cacheReadTokens;
        usage.cacheWriteTokens += res.usage.cacheWriteTokens;

        if (res.stopReason === "refusal") {
          log.warn({ phone: ctx.phoneId }, "el modelo rechazó la solicitud");
          return finish([es.outOfScope()], "rejected_out_of_scope");
        }
        const call = res.toolCalls[0];
        if (!call) {
          log.info({ text: res.text?.slice(0, 80) ?? null }, "sin tool_call: fuera de alcance");
          return finish([es.outOfScope()], "rejected_out_of_scope");
        }
        const spec = byName.get(call.name);
        const parsed = spec ? (spec.schema as z.ZodType).safeParse(call.input) : null;
        if (!spec || !parsed?.success) {
          invalidRetries += 1;
          log.warn(
            {
              tool: call.name,
              issues: parsed && !parsed.success ? parsed.error.issues.slice(0, 3) : "desconocida",
            },
            "argumentos inválidos",
          );
          if (invalidRetries > 1) return finish([es.outOfScope()], "rejected_out_of_scope");
          turns.push({ role: "assistant", text: res.text, toolCalls: [call] });
          turns.push({
            role: "tool_result",
            toolUseId: call.id,
            isError: true,
            content: `Argumentos inválidos: ${parsed && !parsed.success ? parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") : "herramienta desconocida"}. Corrige y vuelve a llamar.`,
          });
          continue;
        }
        toolCalls.push({ name: call.name, args: parsed.data });
        const outcome = await (spec as ToolSpec<z.ZodType>).run(parsed.data, {
          tx,
          ctx,
          userText,
          now: started,
        });
        if (outcome.kind === "terminal") {
          log.info(
            {
              tool: call.name,
              status: outcome.status,
              ms: now().getTime() - started.getTime(),
              usage,
            },
            "agente terminó",
          );
          return finish(outcome.outbound, outcome.status);
        }
        turns.push({ role: "assistant", text: res.text, toolCalls: [call] });
        turns.push({ role: "tool_result", toolUseId: call.id, content: outcome.resultForModel });
      }
      log.warn({ iterations: maxIterations }, "tope de iteraciones");
      return finish([es.outOfScope()], "rejected_out_of_scope");
    },
  };
}

/** Últimos mensajes de texto del teléfono, como turnos alternos. Sin cuerpos de medios. */
async function recentHistory(
  tx: Tx,
  phoneId: string,
  limit: number,
  since: Date,
): Promise<LlmTurn[]> {
  const rows = await tx
    .select({
      direction: schema.message.direction,
      body: schema.message.body,
      kind: schema.message.kind,
    })
    .from(schema.message)
    .where(and(eq(schema.message.phoneId, phoneId), gt(schema.message.createdAt, since)))
    .orderBy(desc(schema.message.createdAt))
    .limit(limit + 1);
  // El último `in` es el mensaje actual (ya insertado antes de llamar al agente): se excluye.
  const ordered = rows.reverse();
  const current =
    ordered.length && ordered[ordered.length - 1]?.direction === "in" ? ordered.pop() : null;
  void current;
  const turns: LlmTurn[] = [];
  for (const r of ordered) {
    if (!r.body) continue;
    if (r.direction === "in")
      turns.push({ role: "user", text: `Mensaje anterior del usuario: ${JSON.stringify(r.body)}` });
    else
      turns.push({
        role: "assistant",
        text: `(respuesta enviada al usuario) ${r.body.slice(0, 300)}`,
        toolCalls: [],
      });
  }
  // La API exige que el primer turno sea del usuario.
  while (turns.length && turns[0]?.role !== "user") turns.shift();
  return turns;
}

export { LlmUnavailableError };
