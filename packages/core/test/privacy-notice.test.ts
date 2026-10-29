import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveHabitSettings } from "../src/ledger/habits";
import { botHarness, CASHIER } from "./bot-harness";

/** H53 (PRD hábitos US-200): la línea de la política nueva, una vez por teléfono del dueño. */
const LINE =
  "_Actualizamos la política de privacidad por los recordatorios, los avisos y la racha. Léela en https://caja.test/privacidad_";

describe("aviso de la política nueva (H53)", () => {
  let h: Awaited<ReturnType<typeof botHarness>>;
  beforeAll(async () => {
    h = await botHarness({ privacyNotice: true });
    await saveHabitSettings(h.t.db, { prefs: true }, "test", new Date());
  });
  afterAll(() => h.t.close());

  it("no va al empleado ni sobre la tarjeta de «no me escribas»", async () => {
    expect(await h.send("hola", CASHIER)).not.toContain("Actualizamos la política");
    expect(await h.send("no me escribas")).not.toContain("Actualizamos la política");
  });

  it("va una vez, arriba de la próxima respuesta del dueño", async () => {
    const first = await h.send("hola");
    expect(first.startsWith(`${LINE}\n\n`)).toBe(true);
    expect(await h.send("hola")).not.toContain("Actualizamos la política");
  });
});
