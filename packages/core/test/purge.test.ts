import { eq, schema, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { purgeOldTenantData, purgeOldWebhookPayloads } from "../src/ledger/purge";
import { MemoryObjectStore } from "../src/storage/index";

const DAY = 24 * 60 * 60 * 1000;

/** Conservación de /privacidad: texto de los mensajes a los 90 días, fotos a los 12 meses. */
describe("conservación de datos", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  let phoneId: string;
  const now = new Date("2026-10-06T15:00:00Z");
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const store = new MemoryObjectStore();
  const run = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(t.db, tenantId, fn);

  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Conserva",
      businessType: "food",
      ownerPhone: "584121119999",
    });
    phoneId = (await run((tx) => tx.select().from(schema.phoneNumber)))[0]?.id ?? "";
    const [oldEv] = await t.db
      .insert(schema.webhookEvent)
      .values({
        eventKey: "old",
        payload: { text: "gasté 15$" },
        status: "done",
        receivedAt: ago(91),
      })
      .returning();
    await t.db
      .insert(schema.webhookEvent)
      .values({ eventKey: "new", payload: { text: "hoy" }, status: "done", receivedAt: ago(10) });
    await t.db.insert(schema.webhookEvent).values({
      eventKey: "pend",
      payload: { text: "en cola" },
      status: "received",
      receivedAt: ago(91),
    });
    await run(async (tx) => {
      await tx.insert(schema.message).values([
        {
          tenantId,
          phoneId,
          direction: "in",
          kind: "text",
          body: "gasté 15$ en champú",
          createdAt: ago(91),
          webhookEventId: oldEv?.id ?? null,
        },
        {
          tenantId,
          phoneId,
          direction: "out",
          kind: "buttons",
          body: "¿Guardo?",
          toolCalls: [{ name: "draft_expense", args: { description: "Champú" } }],
          createdAt: ago(91),
        },
        { tenantId, phoneId, direction: "in", kind: "text", body: "reciente", createdAt: ago(89) },
      ]);
      await tx.insert(schema.pendingAction).values([
        {
          tenantId,
          phoneId,
          kind: "create_expense",
          payload: { description: "Champú" },
          status: "confirmed",
          expiresAt: ago(90),
          createdAt: ago(91),
        },
        {
          tenantId,
          phoneId,
          kind: "create_expense",
          payload: { description: "Pan" },
          status: "confirmed",
          expiresAt: ago(5),
          createdAt: ago(6),
        },
      ]);
      await tx.insert(schema.attachment).values([
        {
          tenantId,
          kind: "receipt",
          storageKey: "vieja.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 1,
          createdAt: ago(366),
        },
        {
          tenantId,
          kind: "receipt",
          storageKey: "nueva.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 1,
          createdAt: ago(300),
        },
      ]);
    });
    await store.put("vieja.jpg", new Uint8Array([1]), "image/jpeg");
    await store.put("nueva.jpg", new Uint8Array([1]), "image/jpeg");
  });
  afterAll(() => t.close());

  it("borra el texto viejo (deja los nombres de herramientas) y las fotos de más de 12 meses", async () => {
    const r = await run((tx) => purgeOldTenantData(tx, store, tenantId, now));
    expect(r).toEqual({ texts: 2, drafts: 1, photos: 1 });
    const msgs = await run((tx) =>
      tx.select().from(schema.message).orderBy(schema.message.createdAt),
    );
    expect(msgs.map((m) => m.body)).toEqual([null, null, "reciente"]);
    expect(msgs.find((m) => m.direction === "out")?.toolCalls).toEqual([{ name: "draft_expense" }]);
    const drafts = await run((tx) =>
      tx.select().from(schema.pendingAction).orderBy(schema.pendingAction.createdAt),
    );
    expect(drafts.map((d) => d.payload)).toEqual([{}, { description: "Pan" }]);
    const atts = await run((tx) =>
      tx.select().from(schema.attachment).orderBy(schema.attachment.createdAt),
    );
    expect(atts.map((a) => a.deletedAt !== null)).toEqual([true, false]);
    expect([...store.objects.keys()]).toEqual(["nueva.jpg"]);
    // Una segunda vuelta no encuentra nada más.
    expect(await run((tx) => purgeOldTenantData(tx, store, tenantId, now))).toEqual({
      texts: 0,
      drafts: 0,
      photos: 0,
    });
  });

  it("vacía el mensaje crudo de eventos cerrados con más de 90 días", async () => {
    expect(await purgeOldWebhookPayloads(t.db, now)).toBe(1);
    const evs = await t.db.select().from(schema.webhookEvent);
    const byKey = Object.fromEntries(evs.map((e) => [e.eventKey, e.payload]));
    expect(byKey).toEqual({
      old: { purged: true },
      new: { text: "hoy" },
      pend: { text: "en cola" },
    });
    expect(await purgeOldWebhookPayloads(t.db, now)).toBe(0);
    const [ev] = await t.db
      .select()
      .from(schema.webhookEvent)
      .where(eq(schema.webhookEvent.eventKey, "old"));
    expect(ev?.status).toBe("done");
  });
});
