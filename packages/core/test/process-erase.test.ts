import { eq, schema, withTenant } from "@caja/db";
import type { ProcessMessageJob } from "@caja/db/queue";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stubAgent } from "../src/agent/stub";
import { ingestWebhook } from "../src/inbox/ingest";
import { ERASE_WORDS, type ProcessDeps, processInbound } from "../src/inbox/process";
import { MemoryObjectStore } from "../src/storage/index";
import { MetaClient } from "../src/whatsapp/client";
import * as fx from "./fixtures";

type Sent = { url: string; body: Record<string, unknown> };

/** "eliminar mi cuenta" por WhatsApp (0017): solo el dueño, con confirmación por botón. */
describe("eliminar la cuenta por WhatsApp", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  const OWNER = "584121234567";
  const EMPLOYEE = "584140000002";
  const userId = "66666666-6666-4666-8666-666666666666";
  // Hora real: la marca de la confirmación se guarda con la hora de la base.
  const now = () => new Date();
  const jobs: ProcessMessageJob[] = [];
  const sent: Sent[] = [];
  const store = new MemoryObjectStore();
  const deletedUsers: string[] = [];
  let n = 0;

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (body.status !== "read") sent.push({ url: String(url), body });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.OUT.${++n}` }], success: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const meta = new MetaClient({ accessToken: "T", phoneNumberId: fx.PHONE_NUMBER_ID, fetchImpl });

  const deps = (): ProcessDeps => ({
    db: t.db,
    metaFor: (id) => (id === fx.PHONE_NUMBER_ID ? meta : null),
    agent: stubAgent,
    now,
    store,
    authAdmin: { deleteUser: async (id) => void deletedUsers.push(id) },
    config: {
      assistantName: "Asistente de Caja",
      dashboardUrl: "https://caja.test",
      supportHint: null,
      unknownReplyMax: 5,
      unknownReplyWindowMs: 3_600_000,
      maxEventAgeMs: 12 * 3_600_000,
      maxTextLength: 500,
    },
  });

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Cinnamon rolls",
      businessType: "food",
      ownerPhone: OWNER,
    });
    await withTenant(t.db, tenantId, async (tx) => {
      await tx.insert(schema.phoneNumber).values({
        tenantId,
        e164: EMPLOYEE,
        role: "employee",
        status: "active",
        verifiedAt: new Date(),
      });
      await tx.insert(schema.attachment).values({
        tenantId,
        kind: "receipt",
        storageKey: `${tenantId}/f.jpg`,
        mimeType: "image/jpeg",
        sizeBytes: 1,
      });
    });
    await t.db.insert(schema.userAccount).values({ id: userId, email: "dueno@test" });
    await withTenant(t.db, tenantId, (tx) =>
      tx.insert(schema.tenantMember).values({ tenantId, userId, role: "owner" }),
    );
    await store.put(`${tenantId}/f.jpg`, new Uint8Array([1]), "image/jpeg");
  });
  afterAll(() => t.close());

  async function send(payload: unknown) {
    jobs.length = 0;
    await ingestWebhook(
      { db: t.db, now, enqueue: async (_tx, job) => void jobs.push(job) },
      payload,
    );
    const job = jobs[0];
    if (!job) throw new Error("no se encoló nada");
    return processInbound(deps(), job);
  }

  function text(from: string, body: string) {
    const p = structuredClone(fx.textMessage(`wamid.IN.${++n}`, body)) as unknown as {
      entry: {
        changes: { value: { messages: { from: string }[]; contacts: { wa_id: string }[] } }[];
      }[];
    };
    const v = p.entry[0]?.changes[0]?.value;
    if (v?.messages[0]) v.messages[0].from = from;
    if (v?.contacts[0]) v.contacts[0].wa_id = from;
    return p;
  }

  function button(id: string, title: string) {
    const p = structuredClone(fx.buttonReply) as unknown as {
      entry: {
        changes: {
          value: { messages: { id: string; interactive: { button_reply: unknown } }[] };
        }[];
      }[];
    };
    const m = p.entry[0]?.changes[0]?.value.messages[0];
    if (m) {
      m.id = `wamid.BTN.${++n}`;
      m.interactive.button_reply = { id, title };
    }
    return p;
  }

  const last = () => sent.at(-1)?.body;
  const lastText = () => {
    const b = last();
    return String(
      (b?.text as { body?: string } | undefined)?.body ??
        (b?.interactive as { body?: { text?: string } } | undefined)?.body?.text ??
        "",
    );
  };

  it("reconoce la frase completa y no 'borrar mi cuenta Zelle'", () => {
    expect(ERASE_WORDS.test("eliminar mi cuenta")).toBe(true);
    expect(ERASE_WORDS.test("Quiero borrar mis datos!")).toBe(true);
    expect(ERASE_WORDS.test("borrar mi cuenta Zelle")).toBe(false);
    expect(ERASE_WORDS.test("elimina el último")).toBe(false);
  });

  it("empleado: solo el dueño", async () => {
    await send(text(EMPLOYEE, "eliminar mi cuenta"));
    expect(lastText()).toContain("Solo el dueño puede eliminar");
  });

  it("botón sin haber pedido la confirmación: venció; No: no borra", async () => {
    await send(button("erase:yes", "Sí, eliminar todo"));
    expect(lastText()).toContain("ya venció");
    await send(text(OWNER, "eliminar mi cuenta"));
    expect(lastText()).toContain("No se puede deshacer");
    const ids = (
      (last()?.interactive as { action?: { buttons?: { reply: { id: string } }[] } } | undefined)
        ?.action?.buttons ?? []
    ).map((b) => b.reply.id);
    expect(ids).toEqual(["erase:yes", "erase:no"]);
    await send(button("erase:no", "No, cancelar"));
    expect(lastText()).toContain("no borré nada");
    const [row] = await t.db.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId));
    expect(row).toBeDefined();
  });

  it("confirmado: borra todo, se despide y limpia fotos y usuario del panel", async () => {
    await send(text(OWNER, "eliminar mi cuenta"));
    expect(await send(button("erase:yes", "Sí, eliminar todo"))).toBe("done");
    expect(lastText()).toContain("Eliminamos *Cinnamon rolls*");
    expect(await t.db.select().from(schema.tenant)).toEqual([]);
    expect(await t.db.select().from(schema.phoneNumber)).toEqual([]);
    expect(await t.db.select().from(schema.message)).toEqual([]);
    expect(await t.db.select().from(schema.webhookEvent)).toEqual([]);
    expect(store.objects.size).toBe(0);
    expect(deletedUsers).toEqual([userId]);
    // Después es un número desconocido: recibe el enlace de registro.
    expect(await send(text(OWNER, "hola"))).toBe("ignored");
    expect(lastText()).toContain("/registro");
  });
});
