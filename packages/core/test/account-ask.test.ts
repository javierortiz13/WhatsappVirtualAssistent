import { eq, schema, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LlmClient, LlmResponse } from "../src/agent/llm";
import { createAgent } from "../src/agent/loop";
import { asIsoDate } from "../src/domain/dates";
import { Decimal } from "../src/domain/money";
import { ingestWebhook } from "../src/inbox/ingest";
import { type ProcessDeps, processInbound } from "../src/inbox/process";
import { createAccount } from "../src/ledger/accounts";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

/**
 * De qué cuenta fue (PRD cash-in-drawer, fase 3). Un negocio con cuenta de efectivo: la dicha, la
 * única posible o la de siempre; si no, el movimiento queda sin cuenta y la tarjeta pregunta.
 */
const OWNER = "584121234567";
const TODAY = "2026-09-29";

type Script = Record<string, LlmResponse["toolCalls"]>;

function scriptedLlm(script: Script): LlmClient & { calls: number } {
  const llm = {
    calls: 0,
    model: "claude-sonnet-5-5",
    async complete(req: Parameters<LlmClient["complete"]>[0]) {
      llm.calls += 1;
      const last = req.turns[req.turns.length - 1];
      const text = last && "text" in last ? (last.text ?? "") : "";
      // La clave más larga primero: "gasté 15$ en champú en efectivo" antes que "gasté 15$ en champú".
      const key = Object.keys(script)
        .sort((a, b) => b.length - a.length)
        .find((k) => text.includes(k));
      if (!key) throw new Error(`sin guion para: ${text.slice(-80)}`);
      return {
        toolCalls: script[key] ?? [],
        text: null,
        stopReason: "tool_use" as const,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        model: "claude-sonnet-5-5",
      };
    },
    costUsd: () => new Decimal(0),
  };
  return llm;
}

const expense = (amount: string, currency: string, description: string, when = "") => [
  {
    id: "e",
    name: "draft_expense",
    input: {
      amount,
      currency,
      description,
      category_name: "",
      when,
      rate: "",
      corrects_draft: false,
    },
  },
];

type Sent = { to: string; body: Record<string, unknown> };

/** Un negocio de prueba con sus cuentas, el bot y lo que se mandó. */
async function shop(
  accounts: readonly (readonly [string, "USD" | "VES", "cash" | "bank" | "zelle" | "crypto"])[],
  script: Script,
  opts: { employee?: string } = {},
) {
  const t = await createTestDb();
  const tenantId = await seedTenant(t.db, {
    name: "Autolavado",
    businessType: "car_wash",
    ownerPhone: OWNER,
  });
  for (const d of ["2026-08-20", "2026-08-28", "2026-09-27", "2026-09-28", TODAY])
    await t.db
      .insert(schema.bcvRate)
      .values({ effectiveDate: d, rate: "200.00000000", source: "test" });
  await withTenant(t.db, tenantId, async (tx) => {
    const [phone] = await tx.select().from(schema.phoneNumber);
    for (const [name, currency, kind] of accounts)
      await createAccount(tx, {
        tenantId,
        name,
        currency,
        kind,
        openingBalance: new Decimal(0),
        openingKnown: true,
        openingDate: asIsoDate("2026-08-01"),
        actor: { phoneId: phone?.id as string },
        channel: "whatsapp",
      });
  });
  if (opts.employee)
    await withTenant(t.db, tenantId, (tx) =>
      tx.insert(schema.phoneNumber).values({
        tenantId,
        e164: opts.employee as string,
        role: "employee",
        status: "active",
        displayName: "Cajero",
        verifiedAt: new Date(),
      }),
    );
  const llm = scriptedLlm(script);
  let now = new Date(`${TODAY}T15:00:00Z`);
  const sent: Sent[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (body.status !== "read") sent.push({ to: String(body.to ?? ""), body });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT.${Math.random()}` }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const client = new MetaClient({ accessToken: "T", phoneNumberId: fx.PHONE_NUMBER_ID, fetchImpl });
  const deps = (): ProcessDeps => ({
    db: t.db,
    metaFor: () => client,
    agent: createAgent({ llm, now: () => now }),
    now: () => now,
    config: {
      assistantName: "Rocco",
      dashboardUrl: "https://caja.test",
      supportHint: null,
      unknownReplyMax: 50,
      unknownReplyWindowMs: 3_600_000,
      maxEventAgeMs: 400 * 86_400_000,
      maxTextLength: 500,
      captionWaitMs: 0,
    },
  });
  let seq = 0;
  const jobs: ProcessMessageJob[] = [];
  async function deliver(p: Record<string, unknown>) {
    jobs.length = 0;
    await ingestWebhook(
      { db: t.db, now: () => now, enqueue: async (_tx, job) => void jobs.push(job) },
      p,
    );
    await processInbound(deps(), jobs[0] as ProcessMessageJob);
  }
  const from = (
    p: { entry: { changes: { value: Record<string, unknown> }[] }[] },
    phone: string,
  ) => {
    const v = p.entry[0]?.changes[0]?.value as {
      messages: { from: string }[];
      contacts: { wa_id: string }[];
    };
    v.messages[0] = { ...v.messages[0], from: phone } as { from: string };
    v.contacts[0] = { ...v.contacts[0], wa_id: phone } as { wa_id: string };
    return p;
  };
  /** Movimientos de la base: [monto, cuenta]. */
  const movements = () =>
    withTenant(t.db, tenantId, async (tx) => {
      const names = new Map(
        (await tx.select().from(schema.account)).map((a) => [a.id, a.name] as const),
      );
      return (await tx.select().from(schema.movement).orderBy(schema.movement.createdAt)).map(
        (m) => ({ ...m, account: names.get(m.accountId ?? "") ?? null }),
      );
    });
  return {
    t,
    tenantId,
    llm,
    sent,
    setNow: (d: Date) => {
      now = d;
    },
    movements,
    /** Manda un texto y devuelve [monto, cuenta] de lo que guardó. */
    async send(text: string, phone = OWNER) {
      const before = new Set((await movements()).map((m) => m.id));
      await deliver(from(structuredClone(fx.textMessage(`wamid.T${++seq}`, text)), phone));
      return (await movements())
        .filter((m) => !before.has(m.id))
        .map((m) => [m.amount, m.account] as const);
    },
    async tap(id: string, title: string, phone = OWNER, list = false) {
      const p = structuredClone(list ? fx.listReply : fx.buttonReply) as unknown as {
        entry: { changes: { value: Record<string, unknown> }[] }[];
      };
      const v = p.entry[0]?.changes[0]?.value as unknown as { messages: Record<string, unknown>[] };
      const m = v.messages[0] as { id: string; interactive: Record<string, unknown> };
      m.id = `wamid.B${++seq}`;
      m.interactive = list
        ? { type: "list_reply", list_reply: { id, title } }
        : { type: "button_reply", button_reply: { id, title } };
      await deliver(from(p, phone));
    },
    last: () => sent.at(-1),
    close: () => t.close(),
  };
}

/** Ejemplo del PRD: Efectivo $ y Bs, BofA, Zelle y Banesco (la principal en Bs). */
const EXAMPLE = [
  ["Efectivo $", "USD", "cash"],
  ["BofA", "USD", "bank"],
  ["Zelle", "USD", "zelle"],
  ["Banesco", "VES", "bank"],
  ["Efectivo Bs", "VES", "cash"],
] as const;

describe("US-003: la cuenta en orden (dicha, la única, la de siempre)", () => {
  let s: Awaited<ReturnType<typeof shop>>;
  beforeAll(async () => {
    s = await shop(EXAMPLE, {
      "gasté 15$ en champú en efectivo": expense("15", "USD", "champú"),
      "pagué 12 mil de hielo en efectivo": expense("12000", "VES", "hielo"),
      "gasté 15$ en champú por zelle": expense("15", "USD", "champú"),
      "pagué 10$ con la tarjeta": expense("10", "USD", "repuesto"),
      "pagué 10$ por pago móvil": expense("10", "USD", "repuesto"),
      "lo pagué por el banco, 10$": expense("10", "USD", "repuesto"),
      "pagué 10$ de BofA": expense("10", "USD", "repuesto"),
      "pagué 10$ con Banesco": expense("10", "USD", "repuesto"),
      "gasté 15$ en champú": expense("15", "USD", "champú"),
      "pagué 12 mil de hielo": expense("12000", "VES", "hielo"),
      "gasté 8$ en cera": expense("8", "USD", "cera"),
      "gasté 3$ en trapos en efectivo": expense("3", "USD", "trapos"),
      "gasté 4$ en esponjas en efectivo": expense("4", "USD", "esponjas"),
      "gasté 5$ en guantes en efectivo": expense("5", "USD", "guantes"),
      "gasté 2$ en bolsas en efectivo": expense("2", "USD", "bolsas"),
    });
  });
  afterAll(() => s.close());

  it("dicha en el mensaje", async () => {
    expect(await s.send("gasté 15$ en champú en efectivo")).toEqual([["15.00", "Efectivo $"]]);
    expect(await s.send("pagué 12 mil de hielo en efectivo")).toEqual([
      ["12000.00", "Efectivo Bs"],
    ]);
    expect(await s.send("gasté 15$ en champú por zelle")).toEqual([["15.00", "Zelle"]]);
    expect(await s.send("pagué 10$ con la tarjeta")).toEqual([["10.00", "Banesco"]]);
    expect(await s.send("pagué 10$ por pago móvil")).toEqual([["10.00", "Banesco"]]);
    expect(await s.send("lo pagué por el banco, 10$")).toEqual([["10.00", "Banesco"]]);
    expect(await s.send("pagué 10$ de BofA")).toEqual([["10.00", "BofA"]]);
    expect(await s.send("pagué 10$ con Banesco")).toEqual([["10.00", "Banesco"]]);
  });

  it("sin decir y con varias posibles: sin cuenta (4 en $, 2 en Bs)", async () => {
    await withTenant(s.t.db, s.tenantId, (tx) => tx.delete(schema.movement));
    expect(await s.send("gasté 8$ en cera")).toEqual([["8.00", null]]);
    expect(await s.send("pagué 12 mil de hielo")).toEqual([["12000.00", null]]);
  });

  it("la de siempre: dos 'champú' de Efectivo $ en 30 días; uno solo no alcanza", async () => {
    expect(await s.send("gasté 15$ en champú en efectivo")).toEqual([["15.00", "Efectivo $"]]);
    expect(await s.send("gasté 15$ en champú")).toEqual([["15.00", null]]);
    expect(await s.send("gasté 15$ en champú en efectivo")).toEqual([["15.00", "Efectivo $"]]);
    expect(await s.send("gasté 15$ en champú")).toEqual([["15.00", "Efectivo $"]]);
    const [last] = (await s.movements()).slice(-1);
    expect(last?.accountId).toBeTruthy();
  });

  it("de hace más de 30 días no cuenta; mitad y mitad pregunta", async () => {
    await withTenant(s.t.db, s.tenantId, (tx) =>
      tx.update(schema.movement).set({ businessDate: "2026-08-28" }),
    );
    expect(await s.send("gasté 15$ en champú")).toEqual([["15.00", null]]);
    await withTenant(s.t.db, s.tenantId, (tx) => tx.delete(schema.movement));
    await s.send("gasté 15$ en champú en efectivo");
    await s.send("gasté 15$ en champú en efectivo");
    await s.send("gasté 15$ en champú por zelle");
    await s.send("gasté 15$ en champú por zelle");
    expect(await s.send("gasté 15$ en champú")).toEqual([["15.00", null]]);
  });

  it("por categoría: 3 de la misma categoría de Efectivo $; 2 no alcanzan", async () => {
    await withTenant(s.t.db, s.tenantId, (tx) => tx.delete(schema.movement));
    await s.send("gasté 3$ en trapos en efectivo");
    await s.send("gasté 4$ en esponjas en efectivo");
    expect(await s.send("gasté 8$ en cera")).toEqual([["8.00", null]]);
    await withTenant(s.t.db, s.tenantId, (tx) =>
      tx.delete(schema.movement).where(eq(schema.movement.description, "cera")),
    );
    await s.send("gasté 5$ en guantes en efectivo");
    expect(await s.send("gasté 8$ en cera")).toEqual([["8.00", "Efectivo $"]]);
  });
});

describe("US-003: la única posible", () => {
  it("solo Efectivo $ y Banesco: $ pregunta (las dos); Bs va a Banesco", async () => {
    const s = await shop(
      [
        ["Efectivo $", "USD", "cash"],
        ["Banesco", "VES", "bank"],
      ],
      {
        "gasté 15$ en champú": expense("15", "USD", "champú"),
        "pagué 12 mil de hielo": expense("12000", "VES", "hielo"),
      },
    );
    expect(await s.send("gasté 15$ en champú")).toEqual([["15.00", null]]);
    expect(await s.send("pagué 12 mil de hielo")).toEqual([["12000.00", "Banesco"]]);
    await s.close();
  });

  it("solo Efectivo $, sin banco en Bs: $ va a Efectivo $", async () => {
    const s = await shop([["Efectivo $", "USD", "cash"]], {
      "gasté 15$ en champú": expense("15", "USD", "champú"),
    });
    expect(await s.send("gasté 15$ en champú")).toEqual([["15.00", "Efectivo $"]]);
    await s.close();
  });

  it("sin cuenta de efectivo: como antes, la principal sin preguntar", async () => {
    const s = await shop(
      [
        ["BofA", "USD", "bank"],
        ["Banesco", "VES", "bank"],
      ],
      { "gasté 15$ en champú": expense("15", "USD", "champú") },
    );
    expect(await s.send("gasté 15$ en champú")).toEqual([["15.00", "Banesco"]]);
    await s.close();
  });
});

// ---------------------------------------------------------------- US-004 … US-007

type Interactive = {
  type: "button" | "list";
  body: { text: string };
  action: {
    buttons?: { reply: { id: string; title: string } }[];
    button?: string;
    sections?: { rows: { id: string; title: string; description?: string }[] }[];
  };
};
const card = (sent: Sent | undefined) => sent?.body.interactive as Interactive | undefined;
const buttons = (sent: Sent | undefined) =>
  card(sent)?.action.buttons?.map((b) => b.reply.title) ?? [];
const rows = (sent: Sent | undefined) => card(sent)?.action.sections?.[0]?.rows ?? [];
const idOf = (sent: Sent | undefined, title: string) =>
  [
    ...(card(sent)?.action.buttons?.map((b) => b.reply) ?? []),
    ...rows(sent).map((r) => ({ id: r.id, title: r.title })),
  ].find((r) => r.title === title)?.id ?? "";

const CASHIER = "584149876543";
const ask = (question: string) => [
  { id: "q", name: "ask_clarification", input: { question, options: [] } },
];
const dayTotal = (total: string, lines: [string, string][], corrects = false) => [
  {
    id: "d",
    name: "draft_income_day_total",
    input: {
      total_amount: total,
      total_currency: "USD",
      lines: lines.map(([method, amount]) => ({ method, amount, currency: "unknown" })),
      when: "",
      rate: "",
      corrects_draft: corrects,
    },
  },
];

describe("US-004…US-007: la tarjeta pregunta y la respuesta pone la cuenta", () => {
  let s: Awaited<ReturnType<typeof shop>>;
  beforeAll(async () => {
    s = await shop(
      EXAMPLE,
      {
        "gasté 8$ en cera": expense("8", "USD", "cera"),
        "gasté 9$ en cera": expense("9", "USD", "cera"),
        "pagué 12 mil de hielo": expense("12000", "VES", "hielo"),
        "gasté 15$ en champú en efectivo": expense("15", "USD", "champú"),
        "hoy vendí 350$": dayTotal("350", []),
        "200 efectivo, 150 pago móvil": dayTotal(
          "350",
          [
            ["cash_usd", "200"],
            ["pago_movil", "150"],
          ],
          true,
        ),
        "cuánto tengo en efectivo": ask("x"),
        "mis cuentas": ask("x"),
        "qué gasté en efectivo hoy": ask("x"),
        "¿en efectivo?": ask("x"),
        gracias: ask("x"),
        "de BofA": ask("x"),
        "en efectivo": ask("no debió llegar a la IA"),
      },
      { employee: CASHIER },
    );
  });
  afterAll(() => s.close());

  it("con la cuenta dicha, la tarjeta de siempre: Corregir · Deshacer", async () => {
    await s.send("gasté 15$ en champú en efectivo");
    expect(buttons(s.last())).toEqual(["Corregir", "Deshacer"]);
  });

  it("2 candidatas: botones con las cuentas y Deshacer; un toque pone la cuenta y solo reacciona", async () => {
    expect(await s.send("pagué 12 mil de hielo")).toEqual([["12000.00", null]]);
    expect(card(s.last())?.body.text).toMatch(/\n\n¿Cómo lo pagaste\?$/);
    expect(buttons(s.last())).toEqual(["Banesco", "Efectivo Bs", "Deshacer"]);
    const id = idOf(s.last(), "Efectivo Bs");
    const before = s.sent.length;
    await s.tap(id, "Efectivo Bs");
    expect(s.sent.slice(before).map((m) => m.body.type)).toEqual(["reaction"]);
    expect((s.sent.at(-1)?.body.reaction as { emoji: string } | undefined)?.emoji).toBe("✅");
    const [m] = (await s.movements()).slice(-1);
    expect(m?.account).toBe("Efectivo Bs");
    // Otro toque: reacción y nada cambia.
    await s.tap(
      idOf(s.sent.at(-2), "Banesco") || id.replace(/:[^:]+$/, `:${m?.accountId}`),
      "Banesco",
    );
    expect((await s.movements()).slice(-1)[0]?.account).toBe("Efectivo Bs");
  });

  it("4 candidatas: lista con saldo para el dueño; Deshacer después del toque borra", async () => {
    await s.send("gasté 8$ en cera");
    const c = card(s.last());
    expect(c?.type).toBe("list");
    expect(c?.action.button).toBe("Elegir cuenta");
    expect(rows(s.last()).map((r) => r.title)).toEqual([
      "Efectivo $",
      "BofA",
      "Zelle",
      "Banesco",
      "Efectivo Bs",
      "Corregir",
      "Deshacer",
    ]);
    expect(rows(s.last())[0]?.description).toMatch(/^Saldo: /);
    const undo = idOf(s.last(), "Deshacer");
    await s.tap(idOf(s.last(), "Zelle"), "Zelle", OWNER, true);
    expect((await s.movements()).slice(-1)[0]?.account).toBe("Zelle");
    await s.tap(undo, "Deshacer", OWNER, true);
    expect((await s.movements()).slice(-1)[0]?.deletedAt).not.toBeNull();
  });

  it("la tarjeta del cajero: sin saldos ni totales, solo la moneda", async () => {
    await s.send("gasté 9$ en cera", CASHIER);
    const last = s.last();
    expect(last?.to).toBe(CASHIER);
    expect(rows(last).map((r) => r.description ?? "")).toEqual([
      "En dólares",
      "En dólares",
      "En dólares",
      "En bolívares",
      "En bolívares",
      "",
      "",
    ]);
    expect(JSON.stringify(last)).not.toMatch(/Saldo|💳/);
    await s.tap(idOf(last, "Efectivo $"), "Efectivo $", CASHIER, true);
    expect(JSON.stringify(s.last())).not.toMatch(/Saldo/);
    expect((await s.movements()).slice(-1)[0]?.account).toBe("Efectivo $");
  });

  it("respuesta escrita corta: sin la IA, ✅ y el mismo movimiento", async () => {
    // Sin historial: si no, la cuenta de siempre de la categoría ya responde sola.
    await withTenant(s.t.db, s.tenantId, (tx) => tx.delete(schema.movement));
    await s.send("gasté 8$ en cera");
    const [m] = (await s.movements()).slice(-1);
    const calls = s.llm.calls;
    const before = s.sent.length;
    await s.send("en efectivo");
    expect(s.llm.calls).toBe(calls);
    expect(s.sent.slice(before).map((x) => x.body.type)).toEqual(["reaction"]);
    const [after] = (await s.movements()).slice(-1);
    expect(after?.id).toBe(m?.id);
    expect(after?.account).toBe("Efectivo $");
  });

  it("'del efectivo en bolívares' en una tarjeta en Bs; preguntas y otra cosa van a la IA", async () => {
    await s.send("pagué 12 mil de hielo");
    for (const text of [
      "cuánto tengo en efectivo",
      "mis cuentas",
      "qué gasté en efectivo hoy",
      "¿en efectivo?",
      "gracias",
      "de BofA",
    ]) {
      const calls = s.llm.calls;
      await s.send(text);
      expect(s.llm.calls, text).toBe(calls + 1);
      expect((await s.movements()).slice(-1)[0]?.account, text).toBeNull();
    }
    const calls = s.llm.calls;
    await s.send("del efectivo en bolívares");
    expect(s.llm.calls).toBe(calls);
    expect((await s.movements()).slice(-1)[0]?.account).toBe("Efectivo Bs");
  });

  it("una tarjeta de otro día ya no toma la respuesta escrita", async () => {
    await s.send("gasté 8$ en cera");
    s.setNow(new Date("2026-09-30T15:00:00Z"));
    const calls = s.llm.calls;
    await s.send("en efectivo");
    expect(s.llm.calls).toBe(calls + 1);
    s.setNow(new Date(`${TODAY}T15:00:00Z`));
  });

  it("'Varios métodos': C12 y el desglose escrito reemplaza la tarjeta", async () => {
    await s.send("hoy vendí 350$");
    expect(rows(s.last()).map((r) => r.title)).toContain("Varios métodos");
    await s.tap(idOf(s.last(), "Varios métodos"), "Varios métodos", OWNER, true);
    expect((s.last()?.body.text as { body: string } | undefined)?.body).toBe(
      "Dime cuánto fue por cada método. Ejemplo: _200 efectivo, 150 pago móvil_",
    );
    await s.send("200 efectivo, 150 pago móvil");
    const live = (await s.movements()).filter((m) => m.type === "income" && !m.deletedAt);
    expect(live.map((m) => [m.amount, m.account])).toEqual([
      ["200.00", "Efectivo $"],
      ["150.00", "Banesco"],
    ]);
  });
});

describe("US-006: crear la cuenta que falta desde la pregunta", () => {
  it("'en efectivo' en Bs sin Efectivo Bs: la ofrece primero; el toque la crea en cero y la usa", async () => {
    const s = await shop(
      [
        ["Efectivo $", "USD", "cash"],
        ["Banesco", "VES", "bank"],
        ["Mercantil", "VES", "bank"],
      ],
      {
        "pagué 12 mil en efectivo": expense("12000", "VES", "hielo"),
        "pagué 13 mil en efectivo": expense("13000", "VES", "hielo"),
      },
    );
    expect(await s.send("pagué 12 mil en efectivo")).toEqual([["12000.00", null]]);
    const first = rows(s.last())[0];
    expect(first).toMatchObject({
      title: "Efectivo Bs",
      description: "Cuenta nueva: la creo al tocarla",
    });
    await s.tap(first?.id ?? "", "Efectivo Bs", OWNER, true);
    expect((s.last()?.body.text as { body: string } | undefined)?.body).toBe(
      "✅ Creé la cuenta *Efectivo Bs* y lo anoté ahí. Si ya tenías plata en ella, ponle el saldo inicial en el panel: https://caja.test/ajustes/cuentas",
    );
    expect((await s.movements()).slice(-1)[0]?.account).toBe("Efectivo Bs");
    const [acc] = await withTenant(s.t.db, s.tenantId, (tx) =>
      tx.select().from(schema.account).where(eq(schema.account.name, "Efectivo Bs")),
    );
    expect(acc?.openingBalance).toBe("0.00");
    // Ya existe: la próxima va directo a ella.
    expect(await s.send("pagué 13 mil en efectivo")).toEqual([["13000.00", "Efectivo Bs"]]);
    await s.close();
  });
});

describe("US-004 C13: la cuenta que no cupo en la lista", () => {
  it("más de 10 filas: sugiere 'fue de {cuenta}' y esa respuesta la pone sin la IA", async () => {
    const banks = [
      "Mercantil",
      "Provincial",
      "Venezolano",
      "Bicentenario",
      "Exterior",
      "Caroni",
      "Plaza",
      "Activo",
      "Sofitasa",
    ].map((n) => [n, "USD", "bank"] as const);
    const s = await shop([["Efectivo $", "USD", "cash"], ...banks, ["Banesco", "VES", "bank"]], {
      "gasté 8$ en cera": expense("8", "USD", "cera"),
    });
    await s.send("gasté 8$ en cera");
    expect(rows(s.last())).toHaveLength(10);
    expect(
      rows(s.last())
        .slice(-2)
        .map((r) => r.title),
    ).toEqual(["Corregir", "Deshacer"]);
    const body = card(s.last())?.body.text ?? "";
    const hint = body.match(/_fue de ([^_]+)_$/)?.[1];
    // Caben Efectivo $ y 7 bancos; la primera candidata que no cupo es Activo.
    expect(hint).toBe("Activo");
    const calls = s.llm.calls;
    await s.send(`fue de ${hint}`);
    expect(s.llm.calls).toBe(calls);
    expect((await s.movements()).slice(-1)[0]?.account).toBe("Activo");
    await s.close();
  });
});
