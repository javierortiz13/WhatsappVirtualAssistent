import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { flagOnDates, whoChanged } from "../src/admin/flag-dates";
import { saveRewardSettings } from "../src/billing/rewards";
import type { IsoDate } from "../src/domain/dates";
import { saveHabitSettings } from "../src/ledger/habits";

const DAY = "2026-11-07" as IsoDate;

/** Consulta solo de fechas (10/11): cuándo y desde dónde se encendieron los interruptores. */
describe("flagOnDates", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(() => t.close());

  it("quién: «/admin» por un correo, «sistema» por el sistema; nunca el correo", () => {
    expect(whoChanged("fundador@ejemplo.com")).toBe("/admin");
    expect(whoChanged("system")).toBe("sistema");
    expect(whoChanged("limpieza 08/11 (aprobada por el fundador)")).toBe(
      "sistema (limpieza 08/11 (aprobada por el fundador))",
    );
    expect(whoChanged(null)).toBe("—");
  });

  it("sin cambios: todo apagado y sin fechas", async () => {
    const r = await flagOnDates(t.db);
    expect(r.flags.map((f) => [f.flag, f.on, f.firstOn, f.savedDay, f.firstTrace])).toEqual([
      ["xp", false, null, null, null],
      ["rewards", false, null, null, null],
      ["referrals", false, null, null, null],
      ["dailyClose", false, null, null, null],
    ]);
  });

  it("encendido y apagado desde /admin: fechas del historial, día guardado y quién, sin correos", async () => {
    const on = new Date("2026-11-07T23:55:00Z");
    const off = new Date("2026-11-08T00:05:00Z");
    await saveHabitSettings(t.db, { xp: true, referrals: true }, "fundador@ejemplo.com", on);
    await saveRewardSettings(
      t.db,
      { xpOnSince: DAY, referralsOnSince: DAY, referralsChangedOn: DAY },
      "fundador@ejemplo.com",
      on,
    );
    await saveHabitSettings(t.db, { xp: false, referrals: false }, "fundador@ejemplo.com", off);
    const r = await flagOnDates(t.db);
    const xp = r.flags.find((f) => f.flag === "xp");
    expect(xp).toMatchObject({
      on: false,
      firstOn: { at: on.toISOString(), by: "/admin" },
      lastOn: { at: on.toISOString(), by: "/admin" },
      lastOff: { at: off.toISOString(), by: "/admin" },
      savedDay: "2026-11-07",
    });
    expect(r.flags.find((f) => f.flag === "referrals")?.savedDay).toBe("2026-11-07");
    expect(r.flags.find((f) => f.flag === "rewards")?.firstOn).toBeNull();
    expect(r.lastChange.habits).toEqual({ at: off.toISOString(), by: "/admin" });
    expect(JSON.stringify(r)).not.toContain("@");
  });
});
