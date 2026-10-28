import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { botHarness, CASHIER } from "./bot-harness";

/** Revisión de seguridad 27/10: lo que solo ve el dueño. */
const balance = [
  {
    id: "b",
    name: "exchange_usdt",
    input: { action: "balance", usd_amount: "", ves_amount: "", rate: "", when: "" },
  },
];

describe("F11: saldo de cambios USDT", () => {
  let h: Awaited<ReturnType<typeof botHarness>>;
  beforeAll(async () => {
    h = await botHarness({ script: { "cuántos bs me quedan": balance } });
  });
  afterAll(() => h.t.close());

  it("el empleado recibe «eso lo ve el dueño»; el dueño ve su saldo", async () => {
    expect(await h.send("cuántos bs me quedan", CASHIER)).toBe(
      "El saldo de los cambios lo ve el dueño. Tú puedes registrar gastos y ventas.",
    );
    expect(await h.send("cuántos bs me quedan")).not.toContain("lo ve el dueño");
  });
});
