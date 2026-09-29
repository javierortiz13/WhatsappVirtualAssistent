import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allowUnknownReply, canUse, resolveSender } from "../src/identity/resolve.js";

describe("identidad", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let tenantId: string;
  beforeAll(async () => {
    t = await createTestDb();
    tenantId = await seedTenant(t.db, {
      name: "Autolavado",
      businessType: "car_wash",
      ownerPhone: "584121234567",
    });
  });
  afterAll(() => t.close());

  it("resuelve un número conocido con su tenant y rol, sin tenant fijado", async () => {
    const r = await resolveSender(t.db, {
      e164: "584121234567",
      waUserId: null,
      displayName: null,
    });
    expect(r).toMatchObject({
      tenantId,
      role: "owner",
      phoneStatus: "active",
      tenantStatus: "trial",
    });
    expect(r && canUse(r)).toBe(true);
  });
  it("desconocido devuelve null", async () => {
    expect(
      await resolveSender(t.db, { e164: "580000000000", waUserId: null, displayName: null }),
    ).toBeNull();
    expect(
      await resolveSender(t.db, { e164: null, waUserId: "BSUID", displayName: null }),
    ).toBeNull();
  });
  it("rate limit de desconocidos: 5 respuestas por hora, luego silencio, y se reinicia la ventana", async () => {
    const now = new Date("2026-09-29T12:00:00Z");
    const opts = { max: 5, windowMs: 3_600_000, now };
    for (let i = 0; i < 5; i++)
      expect(await allowUnknownReply(t.db, "580000000001", opts)).toBe(true);
    expect(await allowUnknownReply(t.db, "580000000001", opts)).toBe(false);
    expect(await allowUnknownReply(t.db, "580000000002", opts)).toBe(true);
    const later = new Date("2026-09-29T13:30:00Z");
    expect(await allowUnknownReply(t.db, "580000000001", { ...opts, now: later })).toBe(true);
  });
});
