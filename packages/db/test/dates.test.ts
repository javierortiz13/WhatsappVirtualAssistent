import { describe, expect, it } from "vitest";
import { createDb, sql } from "../src/index";

/**
 * 08/11: una fecha de JavaScript en SQL escrito a mano rompía las consultas en producción
 * (postgres.js), aunque PGlite la aceptaba. `createDb` la manda como texto ISO.
 */
describe("createDb: fechas en SQL escrito a mano", () => {
  it("una fecha sale como texto ISO; un texto queda igual", async () => {
    const { client, close } = createDb("postgres://x:y@localhost:5432/z");
    const ser = client.options.serializers as Record<string, (v: unknown) => unknown>;
    const at = new Date("2026-11-08T00:02:03.000Z");
    for (const type of ["1184", "1114"]) {
      expect(ser[type]?.(at)).toBe("2026-11-08T00:02:03.000Z");
      expect(ser[type]?.("2026-11-08T00:02:03.000Z")).toBe("2026-11-08T00:02:03.000Z");
    }
    // El fallo era al armar el parámetro: Buffer.byteLength(Date) lanzaba.
    expect(() => Buffer.byteLength(ser["1184"]?.(at) as string)).not.toThrow();
    expect(sql`select ${at}`).toBeTruthy();
    await close();
  });
});
