import { eq, schema, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient, LlmResponse } from "../src/agent/llm";
import { createAgent } from "../src/agent/loop";
import { Decimal } from "../src/domain/money";
import { ingestWebhook } from "../src/inbox/ingest";
import { type ProcessDeps, processInbound } from "../src/inbox/process";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/** Corregir y borrar el último movimiento (US-B8) y tasa manual (ADR-013), de punta a punta. */
type Sent = { body: Record<string, unknown> };
type Interactive = {
  body: { text: string };
  action: { buttons: { reply: { id: string; title: string } }[] };
};
const interactive = (s: Sent | undefined) => s?.body.interactive as Interactive | undefined;
const textOf = (s: Sent | undefined) =>
  String((s?.body.text as { body?: string } | undefined)?.body ?? interactive(s)?.body.text ?? "");
const buttonsOf = (s: Sent | undefined) => interactive(s)?.action.buttons.map((b) => b.reply) ?? [];

function fakeMeta() {
  const sent: Sent[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (body.status !== "read") sent.push({ body });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT.${Math.random()}` }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return {
    sent,
    client: new MetaClient({ accessToken: "T", phoneNumberId: fx.PHONE_NUMBER_ID, fetchImpl }),
  };
}

const expense = (id: string, over: Record<string, unknown> = {}) => [
  {
    id,
    name: "draft_expense",
    input: {
      amount: "15",
      currency: "USD",
      description: "Champú",
      category_name: "Insumos de lavado",
      when: "",
      rate: "",
      corrects_draft: false,
      ...over,
    },
  },
];
const del = (id: string, scope: string, count = 0, description = "") => ({
  id,
  name: "delete_last_movement",
  input: { scope, count, description },
});
const amend = (id: string, over: Record<string, unknown>) => [
  {
    id,
    name: "amend_last_movement",
    input: {
      amount: "",
      currency: "keep",
      category_name: "",
      description: "",
      when: "",
      method: "keep",
      rate: "",
      corrects_draft: false,
      ...over,
    },
  },
];

function scriptedLlm(script: Record<string, LlmResponse["toolCalls"]>): LlmClient {
  return {
    model: "claude-sonnet-5-5",
    async complete(req) {
      const last = req.turns[req.turns.length - 1];
      const text = last && "text" in last ? (last.text ?? "") : "";
      // El mensaje del usuario va al final del turno; el borrador en corrección antes.
      const msg = text.split("Mensaje del usuario: ")[1] ?? "";
      const key = Object.keys(script).find((k) => msg.includes(k));
      if (!key) throw new Error(`sin guion para: ${msg}`);
      return {
        toolCalls: script[key] ?? [],
        text: null,
        stopReason: "tool_use",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: "claude-sonnet-5-5",
      };
    },
    costUsd: () => new Decimal(0),
  };
}

describe("corregir y borrar el último movimiento", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  let clock = new Date("2026-09-29T15:00:00Z");
  const now = () => clock;
  const jobs: ProcessMessageJob[] = [];
  let seq = 0;

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Autolavado",
      businessType: "car_wash",
      ownerPhone: "584121234567",
    });
    await t.db.insert(schema.bcvRate).values([
      { effectiveDate: "2026-09-28", rate: "857.00000000", source: "test" },
      { effectiveDate: "2026-09-29", rate: "858.00000000", source: "test" },
    ]);
  });
  afterAll(() => t.close());

  const llm = scriptedLlm({
    "gasté 15$ en champú": expense("e1"),
    "no, eran 20": amend("a1", { amount: "20" }),
    "es mantenimiento y fue ayer": amend("a2", {
      category_name: "Mantenimiento de equipos",
      when: "ayer",
    }),
    "a tasa 850": amend("a3", { rate: "850" }),
    // El modelo normaliza "857,385" a "857.385": es decimal, no 857.385 Bs (mil veces la tasa).
    "a tasa 857,385": amend("a4", { rate: "857.385" }),
    // "8.580" leído como decimal es 8,58: lejísimos de la BCV (858), se pide de nuevo.
    "a tasa 8.580": amend("a5", { rate: "8.580" }),
    "gasté 30$ en cera a tasa 900": expense("e2", {
      amount: "30",
      description: "Cera",
      rate: "900",
    }),
    "eran 35": expense("e3", { amount: "35", description: "Cera", rate: "900" }),
    "quita eso": [del("d1", "last")],
    "nómina 225.6$ a la tasa euro del día": expense("eu1", {
      amount: "225.6",
      description: "Pago de nómina",
      category_name: "",
      rate: "euro",
    }),
    "corrige a la tasa euro": amend("eu2", { rate: "euro" }),
    "nómina vieja a tasa euro": expense("eu3", {
      amount: "100",
      description: "Nómina",
      when: "2026-09-02",
      rate: "euro",
    }),
    "gasté 7$ en arepa y 7,5$ en pádel": [
      {
        id: "m1",
        name: "draft_expenses",
        input: {
          items: [
            { amount: "7", currency: "USD", description: "Arepa", category_name: "", when: "" },
            { amount: "7.5", currency: "USD", description: "Pádel", category_name: "", when: "" },
          ],
          rate: "",
          corrects_draft: false,
        },
      },
    ],
    "Registrar clases de pilates 15 euros , Gatorade 3$ y taxi 1900bs": [
      {
        id: "eur1",
        name: "draft_expenses",
        input: {
          items: [
            {
              amount: "15",
              currency: "EUR",
              description: "Clases de pilates",
              category_name: "",
              when: "",
            },
            { amount: "3", currency: "USD", description: "Gatorade", category_name: "", when: "" },
            { amount: "1900", currency: "VES", description: "Taxi", category_name: "", when: "" },
          ],
          rate: "",
          corrects_draft: false,
        },
      },
    ],
    "pilates del 2/9, 15 euros": expense("eur2", {
      amount: "15",
      currency: "EUR",
      description: "Clases de pilates",
      when: "2026-09-02",
    }),
    "borra el de la arepa": [del("d2", "matching", 0, "arepa")],
    "borra el del helado": [del("d3", "matching", 0, "helado")],
    bórralos: [del("d4", "last_batch")],
    "borra los 2 últimos": [del("d5", "last_n", 2)],
  });

  function deps(client: MetaClient): ProcessDeps {
    return {
      db: t.db,
      metaFor: () => client,
      agent: createAgent({ llm, now }),
      now,
      config: {
        assistantName: "x",
        dashboardUrl: "https://caja.test",
        supportHint: null,
        unknownReplyMax: 5,
        unknownReplyWindowMs: 3_600_000,
        maxEventAgeMs: 12 * 3_600_000,
        maxTextLength: 500,
        // Este archivo manda muchos mensajes seguidos desde el mismo número.
        knownMax: 1000,
      },
    };
  }
  async function send(client: MetaClient, body: string) {
    jobs.length = 0;
    await ingestWebhook(
      { db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) },
      fx.textMessage(`wamid.L${++seq}`, body),
    );
    return processInbound(deps(client), jobs[0] as ProcessMessageJob);
  }
  async function tap(client: MetaClient, id: string, title: string) {
    jobs.length = 0;
    const p = JSON.parse(JSON.stringify(fx.buttonReply));
    p.entry[0].changes[0].value.messages[0].id = `wamid.LB${++seq}`;
    p.entry[0].changes[0].value.messages[0].interactive.button_reply = { id, title };
    await ingestWebhook({ db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) }, p);
    return processInbound(deps(client), jobs[0] as ProcessMessageJob);
  }
  const live = () =>
    withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.movement).orderBy(schema.movement.createdAt),
    );
  const audits = (action: string) =>
    withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.auditLog).where(eq(schema.auditLog.action, action)),
    );

  it("'no, eran 20' corrige el monto del último gasto guardado, con auditoría de antes y después", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "gasté 15$ en champú");
    await tap(client, buttonsOf(sent[0])[0]?.id as string, "Guardar");
    expect(textOf(sent[1])).toContain("✅ Guardado");
    await send(client, "no, eran 20");
    expect(textOf(sent[2])).toBe("Cambio el último gasto:\nChampú · $15,00 → *$20,00*");
    expect(buttonsOf(sent[2]).map((b) => b.title)).toEqual(["Guardar", "Cancelar"]);
    await tap(client, buttonsOf(sent[2])[0]?.id as string, "Guardar");
    expect(textOf(sent[3])).toBe("✅ Corregido. Gastos de ese día: *$20,00* (1 registro).");
    const [m] = await live();
    expect(m).toMatchObject({ amount: "20.00", amountVes: "17160.00", rateSource: "bcv" });
    const upd = await audits("update");
    expect(upd).toHaveLength(1);
    expect(upd[0]?.before).toMatchObject({ amount: "15.00" });
    expect(upd[0]?.after).toMatchObject({ amount: "20.00" });
  });

  it("categoría y fecha: recalcula la tasa del nuevo día; tasa manual: guarda rate_source manual sin fila BCV", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "es mantenimiento y fue ayer");
    expect(textOf(sent[0])).toContain("Categoría: Insumos de lavado → *Mantenimiento de equipos*");
    expect(textOf(sent[0])).toContain("Fecha: mar 29/09 → *lun 28/09*");
    await tap(client, buttonsOf(sent[0])[0]?.id as string, "Guardar");
    let [m] = await live();
    expect(m).toMatchObject({
      businessDate: "2026-09-28",
      amountVes: "17140.00",
      rateValue: "857.00000000",
    });

    await send(client, "a tasa 8.580");
    expect(textOf(sent[2])).toBe("No entendí la tasa. Escríbela como _tasa 857,89_.");
    await send(client, "a tasa 857,385");
    expect(textOf(sent[3])).toContain("(tasa manual 857,39)");
    const cancel = buttonsOf(sent[3]).find((b) => b.title === "Cancelar");
    await tap(client, cancel?.id as string, "Cancelar");
    await send(client, "a tasa 850");
    const fix = sent.at(-1);
    expect(textOf(fix)).toContain("$20,00 → *$20,00* (tasa manual 850,00)");
    await tap(client, buttonsOf(fix)[0]?.id as string, "Guardar");
    [m] = await live();
    expect(m).toMatchObject({
      rateSource: "manual",
      rateId: null,
      rateValue: "850.00000000",
      amountVes: "17000.00",
    });
  });

  it("tasa manual en un borrador nuevo y en su corrección; 'bórralo' sin LLM borra con confirmación", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "gasté 30$ en cera a tasa 900");
    expect(textOf(sent[0])).toContain("Cera: *$30,00*\nBs 27.000,00 · tasa manual 900,00");
    // Corregir el borrador: el modelo vuelve a llamar draft_expense con la tasa.
    await tap(client, buttonsOf(sent[0])[1]?.id as string, "Corregir");
    expect(textOf(sent[1])).toContain("Dime qué cambio");
    await send(client, "eran 35");
    expect(textOf(sent[2])).toContain("Cera: *$35,00*\nBs 31.500,00 · tasa manual 900,00");
    await tap(client, buttonsOf(sent[2])[0]?.id as string, "Guardar");
    const rows = await live();
    expect(rows[1]).toMatchObject({ amount: "35.00", rateSource: "manual", rateId: null });

    await send(client, "bórralo");
    expect(textOf(sent[4])).toBe("Elimino el último gasto: Cera · $35,00 · hoy, mar 29/09.");
    expect(buttonsOf(sent[4]).map((b) => b.title)).toEqual(["Eliminar", "Cancelar"]);
    await tap(client, buttonsOf(sent[4])[0]?.id as string, "Eliminar");
    expect(textOf(sent[5])).toBe("✅ Eliminado. Gastos de ese día: *$0,00* (0 registros).");
    const after = await live();
    expect(after[1]?.deletedAt).not.toBeNull();
    expect(await audits("delete")).toHaveLength(1);
  });

  it("borrar varios: por nombre, los del último Guardar y los N últimos, con confirmación", async () => {
    const { sent, client } = fakeMeta();
    await send(client, "gasté 7$ en arepa y 7,5$ en pádel");
    await tap(client, buttonsOf(sent[0])[0]?.id as string, "Guardar");
    expect(textOf(sent[1])).toContain("Guardados 2 gastos");

    await send(client, "borra el de la arepa");
    expect(textOf(sent[2])).toBe("Elimino este gasto: Arepa · $7,00 · hoy, mar 29/09.");
    await tap(client, buttonsOf(sent[2])[1]?.id as string, "Cancelar");

    await send(client, "borra el del helado");
    expect(textOf(sent[4])).toContain('No encontré "helado"');

    await send(client, "bórralos");
    expect(textOf(sent[5])).toContain("Elimino 2 gastos:");
    expect(textOf(sent[5])).toContain("Arepa · $7,00");
    expect(textOf(sent[5])).toContain("Pádel · $7,50");
    expect(textOf(sent[5])).not.toContain("Champú");
    expect(buttonsOf(sent[5]).map((b) => b.title)).toEqual(["Eliminar", "Cancelar"]);
    await tap(client, buttonsOf(sent[5])[0]?.id as string, "Eliminar");
    expect(textOf(sent[6])).toContain("✅ Eliminados 2 movimientos.");
    const rows = await live();
    const byDesc = (d: string) => rows.find((r) => r.description === d);
    expect(byDesc("Arepa")?.deletedAt).not.toBeNull();
    expect(byDesc("Pádel")?.deletedAt).not.toBeNull();
    expect(byDesc("Champú")?.deletedAt).toBeNull();

    // Guardados con dos Guardar distintos: "los 2 últimos" los toma a los dos.
    await send(client, "gasté 15$ en champú");
    await tap(client, buttonsOf(sent[7])[0]?.id as string, "Guardar");
    await send(client, "borra los 2 últimos");
    expect(textOf(sent[9])).toBe(
      "Elimino 2 gastos:\n1. Champú · $15,00 · hoy, mar 29/09\n2. Champú · $20,00 · ayer, lun 28/09",
    );
    await tap(client, buttonsOf(sent[9])[1]?.id as string, "Cancelar");
    expect((await live()).filter((r) => !r.deletedAt)).toHaveLength(2);
  });

  it("tasa euro: borrador y guardado a euro BCV, corrección de un guardado y día sin euro", async () => {
    const { sent, client } = fakeMeta();
    await t.db
      .update(schema.bcvRate)
      .set({ rateEur: "976.84000000" })
      .where(eq(schema.bcvRate.effectiveDate, "2026-09-29"));
    await send(client, "nómina 225.6$ a la tasa euro del día");
    expect(textOf(sent[0])).toContain(
      "Pago de nómina: *$225,60*\nBs 220.375,10 · tasa euro 976,84",
    );
    await tap(client, buttonsOf(sent[0])[0]?.id as string, "Guardar");
    const saved = (await live()).find((m) => m.description === "Pago de nómina");
    expect(saved).toMatchObject({
      rateSource: "bcv_eur",
      rateValue: "976.84000000",
      amountUsd: "225.60",
      amountVes: "220375.10",
    });
    expect(saved?.rateId).not.toBeNull();

    // Un gasto guardado a tasa BCV se corrige a tasa euro.
    await send(client, "gasté 15$ en champú");
    await tap(client, buttonsOf(sent[2])[0]?.id as string, "Guardar");
    await send(client, "corrige a la tasa euro");
    expect(textOf(sent[4])).toContain("(tasa euro 976,84)");
    await tap(client, buttonsOf(sent[4])[0]?.id as string, "Guardar");
    const fixed = (await live()).filter((m) => m.description === "Champú").pop();
    expect(fixed).toMatchObject({ rateSource: "bcv_eur", amountVes: "14652.60" });

    // Antes del 02/10 no se guardaba el euro: pide la tasa en vez de inventarla.
    await send(client, "nómina vieja a tasa euro");
    expect(textOf(sent[6])).toContain("Todavía no tengo la tasa euro del BCV de ese día");

    // Montos EN euros: se pasan a Bs con el euro BCV del día; cada ítem conserva su moneda.
    await send(client, "Registrar clases de pilates 15 euros , Gatorade 3$ y taxi 1900bs");
    expect(textOf(sent[7])).toContain(
      "1. Clases de pilates (15,00 € a tasa euro 976,84): *Bs 14.652,60* · Otros\n2. Gatorade: *$3,00* · Otros\n3. Taxi: *Bs 1.900,00* · Otros",
    );
    await tap(client, buttonsOf(sent[7])[0]?.id as string, "Guardar");
    const rows = await live();
    expect(rows.find((m) => m.description?.startsWith("Clases de pilates"))).toMatchObject({
      description: "Clases de pilates (15,00 € a tasa euro 976,84)",
      currency: "VES",
      amountVes: "14652.60",
      rateSource: "bcv",
    });
    expect(rows.find((m) => m.description === "Gatorade")).toMatchObject({
      currency: "USD",
      amountUsd: "3.00",
    });
    expect(rows.find((m) => m.description === "Taxi")).toMatchObject({
      currency: "VES",
      amountVes: "1900.00",
    });
    await send(client, "pilates del 2/9, 15 euros");
    expect(textOf(sent[9])).toBe(
      "Todavía no tengo la tasa euro del BCV de ese día. Dime el monto en dólares o en bolívares.",
    );
  });

  it("después de 30 minutos remite al dashboard; sin movimientos, lo dice", async () => {
    const { sent, client } = fakeMeta();
    // created_at lo pone la base con la hora real; la ventana se mide contra ella.
    clock = new Date(Date.now() + 40 * 60_000);
    await send(client, "no, eran 20");
    expect(textOf(sent[0])).toBe(
      "Ese movimiento ya tiene más de 30 minutos. Lo puedes corregir aquí: https://caja.test/movimientos",
    );
    await send(client, "quita eso");
    expect(textOf(sent[1])).toContain("más de 30 minutos");
    await withTenant(t.db, tenantId, (tx) => tx.update(schema.movement).set({ deletedAt: clock }));
    await send(client, "quita eso");
    expect(textOf(sent[2])).toBe("No tengo ningún movimiento tuyo reciente para corregir.");
  });
});
