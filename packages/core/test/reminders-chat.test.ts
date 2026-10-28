import { eq, schema } from "@caja/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addDays, businessDateOf, caracasInstant, type IsoDate } from "../src/domain/dates";
import { saveHabitSettings } from "../src/ledger/habits";
import { isReminderListAsk } from "../src/reminders/chat";
import { botHarness, CASHIER, idsOf } from "./bot-harness";

/** Recordatorios por chat (PRD hábitos US-303, US-308): crear, preguntar, corregir, borrar, lista. */
const create = (input: Record<string, string>) => [
  {
    id: "c",
    name: "create_reminder",
    input: { amount: "", currency: "unknown", counterparty: "", ...input },
  },
];

const SCRIPT = {
  "pagar la luz mañana a las 3 pm": create({
    text: "pagar la luz",
    kind: "pay",
    amount: "20",
    currency: "USD",
    when: "mañana a las 3 pm",
  }),
  "cobrarle a Pedro mañana": create({
    text: "cobrarle a Pedro",
    kind: "collect",
    amount: "20",
    currency: "USD",
    counterparty: "Pedro",
    when: "mañana",
  }),
  "alquiler mañana a las 9": create({
    text: "pagar el alquiler",
    kind: "pay",
    when: "mañana a las 9",
  }),
  "llamar a mamá": create({ text: "llamar a mamá", kind: "not_money", when: "mañana" }),
  "a las 4 pm": [
    {
      id: "u",
      name: "update_reminder",
      input: { reminder: "", text: "", amount: "", currency: "unknown", when: "a las 4 pm" },
    },
  ],
  "borra el recordatorio": [{ id: "x", name: "cancel_reminder", input: { reminder: "r1" } }],
};

describe("isReminderListAsk", () => {
  it("el mensaje entero", () => {
    for (const t of [
      "mis recordatorios",
      "Recordatorios",
      "¿Qué tengo pendiente?",
      "ver recordatorios",
    ])
      expect(isReminderListAsk(t), t).toBe(true);
    for (const t of ["recuérdame pagar la luz", "borra el recordatorio", "qué tengo que pagar"])
      expect(isReminderListAsk(t), t).toBe(false);
  });
});

describe("recordatorios por chat", () => {
  let h: Awaited<ReturnType<typeof botHarness>>;
  const tomorrow = () => addDays(businessDateOf(new Date()), 1) as IsoDate;
  const rows = () => h.t.db.select().from(schema.reminder);
  const reaction = () => (h.last()?.body.reaction as { emoji?: string } | undefined)?.emoji ?? null;
  const markers = async () => {
    const out = await h.t.db
      .select({ toolCalls: schema.message.toolCalls })
      .from(schema.message)
      .where(eq(schema.message.direction, "out"));
    return out.flatMap((m) =>
      Array.isArray(m.toolCalls) ? (m.toolCalls as { name: string; args: unknown }[]) : [],
    );
  };

  beforeAll(async () => {
    h = await botHarness({ script: SCRIPT });
  });
  afterAll(() => h.t.close());
  beforeEach(async () => {
    await saveHabitSettings(h.t.db, { reminders: true }, "test", new Date());
    await h.t.db.delete(schema.reminder);
    await h.t.db.delete(schema.auditLog);
    await h.t.db.update(schema.tenant).set({ status: "trial" });
  });

  it("con el interruptor apagado no hay herramienta: nada se guarda", async () => {
    await saveHabitSettings(h.t.db, { reminders: false }, "test", new Date());
    await h.send("recuérdame pagar la luz mañana a las 3 pm");
    expect(await rows()).toHaveLength(0);
    // «mis recordatorios» tampoco es la lista: va a la IA como siempre.
    const calls = h.llm.calls;
    await h.send("mis recordatorios");
    expect(h.llm.calls).toBe(calls + 1);
  });

  it("crea el recordatorio y muestra la tarjeta H15 con Corregir y Borrar", async () => {
    const body = await h.send("recuérdame pagar la luz mañana a las 3 pm");
    expect(body).toBe("⏰ Listo, te lo recuerdo *mañana* a las *3 pm*:\nPagar la luz · $20,00");
    const [r] = await rows();
    expect(r?.dueAt.toISOString()).toBe(caracasInstant(tomorrow(), 15).toISOString());
    expect(r).toMatchObject({ kind: "pay", amount: "20.00", currency: "USD", status: "pending" });
    expect(r?.timeWasDefault).toBe(false);
    expect(r?.sourceMessageId).not.toBeNull();
    expect(idsOf(h.last())).toEqual([`rem:fix:${r?.id}`, `rem:del:${r?.id}`]);
    // La auditoría guarda solo los nombres de los campos, nunca el texto (F3-4 (3)).
    const [a] = await h.t.db.select().from(schema.auditLog);
    expect(a?.after).toEqual({ fields: ["text", "kind", "due_at"] });
    expect(JSON.stringify(a)).not.toContain("luz");
  });

  it("sin hora: las 9 am, y lo dice", async () => {
    const body = await h.send("recuérdame cobrarle a Pedro mañana");
    expect(body).toContain("*mañana* a las *9 am*");
    expect(body).toContain("Le puse las 9 am. Si es otra hora, toca *Corregir*.");
    const [r] = await rows();
    expect(r).toMatchObject({ counterparty: "Pedro", kind: "collect", timeWasDefault: true });
  });

  it("7 a 11 sin am/pm pregunta (H17); el toque lo crea una sola vez", async () => {
    const body = await h.send("recuérdame el alquiler mañana a las 9");
    expect(body).toBe("¿A las 9 de la mañana o de la noche?");
    expect(idsOf(h.last())).toEqual(["rem:ampm:am", "rem:ampm:pm"]);
    expect(await rows()).toHaveLength(0);
    const saved = await h.tap("rem:ampm:pm", "9 de la noche");
    expect(saved).toContain("*mañana* a las *9 pm*");
    const [r] = await rows();
    expect(r?.dueAt.toISOString()).toBe(caracasInstant(tomorrow(), 21).toISOString());
    expect(r?.text).toBe("pagar el alquiler");
    // Un segundo toque sobre la misma pregunta no crea otro igual.
    await h.tap("rem:ampm:pm", "9 de la noche");
    expect(await rows()).toHaveLength(1);
  });

  it("no es de plata: H19 y la marca non_money", async () => {
    const body = await h.send("recuérdame llamar a mamá");
    expect(body).toContain("Solo te recuerdo cosas de plata: pagos y cobros.");
    expect(await rows()).toHaveLength(0);
    expect(await markers()).toContainEqual({
      name: "reminder_rejected",
      args: { reason: "non_money" },
    });
  });

  it("el empleado: H29, sin guardar, y sus toques tampoco", async () => {
    const body = await h.send("recuérdame pagar la luz mañana a las 3 pm", CASHIER);
    expect(body).toBe(
      "Los recordatorios son para el dueño de la cuenta. Tú puedes registrar gastos y ventas.",
    );
    expect(await rows()).toHaveLength(0);
    expect(await markers()).toContainEqual({
      name: "reminder_rejected",
      args: { reason: "employee" },
    });
    expect(await h.send("mis recordatorios", CASHIER)).toContain("son para el dueño");
  });

  it("tope de la prueba: 5 pendientes, el sexto es H28", async () => {
    for (let i = 0; i < 5; i++) await h.send("recuérdame pagar la luz mañana a las 3 pm");
    const body = await h.send("recuérdame pagar la luz mañana a las 3 pm");
    expect(body).toBe(
      "Tienes 5 recordatorios pendientes, el máximo de tu prueba gratis. Marca uno como hecho o bórralo en *mis recordatorios*, y me pides el nuevo.",
    );
    expect(await rows()).toHaveLength(5);
  });

  it("Corregir (H15b): el próximo texto cambia la hora y conserva el día", async () => {
    await h.send("recuérdame pagar la luz mañana a las 3 pm");
    const [r] = await rows();
    const prompt = await h.tap(`rem:fix:${r?.id}`, "Corregir");
    expect(prompt).toBe(
      "Dime qué cambio. Ejemplo: _el lunes a las 3 pm_, _son 25$_, _pagar el agua_.",
    );
    const body = await h.send("mejor a las 4 pm");
    expect(h.llm.seen.at(-1)).toContain("El usuario tocó Corregir en este recordatorio");
    expect(body).toContain("*mañana* a las *4 pm*");
    const [after] = await rows();
    expect(after?.dueAt.toISOString()).toBe(caracasInstant(tomorrow(), 16).toISOString());
    expect(after?.text).toBe("pagar la luz");
  });

  it("Borrar: 🗑️, cancelado y sin texto ni monto al instante (F3-4)", async () => {
    await h.send("recuérdame pagar la luz mañana a las 3 pm");
    const [r] = await rows();
    await h.tap(`rem:del:${r?.id}`, "Borrar");
    expect(reaction()).toBe("🗑️");
    const [after] = await rows();
    expect(after).toMatchObject({
      status: "cancelled",
      text: null,
      amount: null,
      currency: null,
      counterparty: null,
    });
  });

  it("borrar por chat (cancel_reminder) con la lista en el contexto", async () => {
    await h.send("recuérdame pagar la luz mañana a las 3 pm");
    await h.send("borra el recordatorio de la luz");
    expect(h.llm.seen.at(-1)).toContain('"ref":"r1"');
    expect(reaction()).toBe("🗑️");
    expect((await rows())[0]?.status).toBe("cancelled");
  });

  it("mis recordatorios (H25), la fila (H26), Ya lo hice y la lista vacía (H27)", async () => {
    await h.send("recuérdame pagar la luz mañana a las 3 pm");
    const [r] = await rows();
    const calls = h.llm.calls;
    const list = await h.send("mis recordatorios");
    expect(h.llm.calls).toBe(calls);
    expect(list).toBe(
      "Tienes 1 recordatorio pendiente. Tócalo para marcarlo como hecho o borrarlo.",
    );
    expect(idsOf(h.last())).toEqual([`rem:open:${r?.id}`]);
    const detail = await h.tap(`rem:open:${r?.id}`, "Pagar la luz");
    expect(detail).toBe("⏰ Pagar la luz · $20,00\nmañana a las 3 pm");
    expect(idsOf(h.last())).toEqual([`rem:done:${r?.id}`, `rem:del:${r?.id}`]);
    await h.tap(`rem:done:${r?.id}`, "Ya lo hice");
    expect(reaction()).toBe("✅");
    expect((await rows())[0]?.status).toBe("done");
    expect(await h.send("¿qué tengo pendiente?")).toBe(
      "No tienes recordatorios pendientes. Pídeme uno así: _recuérdame pagar la luz el viernes a las 9 am_",
    );
  });

  it("Recuérdame mañana: mañana a la misma hora, contando desde hoy", async () => {
    await h.send("recuérdame pagar la luz mañana a las 3 pm");
    const [r] = await rows();
    await h.tap(`rem:snooze:${r?.id}`, "Recuérdame mañana");
    expect(reaction()).toBe("⏰");
    const [after] = await rows();
    expect(after?.dueAt.toISOString()).toBe(
      caracasInstant(addDays(tomorrow(), 1), 15).toISOString(),
    );
    expect(after?.status).toBe("pending");
  });
});
