import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { habitHistory, saveHabitSettings } from "../src/ledger/habits";

/** G1-4: la historia de los interruptores de hábitos (cuándo, cuál, de qué a qué y quién). */
describe("habitHistory (G1-4)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(() => t.close());

  it("dos guardados → dos entradas, solo con los interruptores que cambiaron", async () => {
    const d1 = new Date("2026-11-07T15:00:00Z");
    const d2 = new Date("2026-11-07T16:00:00Z");
    await saveHabitSettings(t.db, { nudge: true, prefs: true }, "fundador@x", d1);
    // `prefs` no cambia (ya estaba encendido): no entra.
    await saveHabitSettings(t.db, { prefs: true, dailyClose: true, nudge: false }, "otro@x", d2);
    // Nada cambia: no se agrega nada.
    await saveHabitSettings(t.db, { prefs: true }, "otro@x", d2);
    const h = await habitHistory(t.db);
    expect(h).toEqual([
      {
        at: d2.toISOString(),
        by: "otro@x",
        changed: { dailyClose: [false, true], nudge: [true, false] },
      },
      {
        at: d1.toISOString(),
        by: "fundador@x",
        changed: { nudge: [false, true], prefs: [false, true] },
      },
    ]);
  });
});
