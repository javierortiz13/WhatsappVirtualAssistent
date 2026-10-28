import { describe, expect, it } from "vitest";
import { isCrossSite } from "../lib/same-origin";

/** Seguridad F4: el POST del login y del logout solo desde el propio panel. */
const ALLOWED = "https://holarocco.com";
const req = (headers: Record<string, string>) =>
  new Request("https://holarocco.com/auth/confirm/verify", { method: "POST", headers });

describe("isCrossSite", () => {
  it("rechaza otro origen o una petición de otro sitio", () => {
    expect(isCrossSite(req({ origin: "https://evil.example" }), ALLOWED)).toBe(true);
    expect(isCrossSite(req({ "sec-fetch-site": "cross-site" }), ALLOWED)).toBe(true);
    expect(isCrossSite(req({ origin: ALLOWED, "sec-fetch-site": "same-site" }), ALLOWED)).toBe(
      true,
    );
  });
  it("acepta el mismo origen (y un navegador viejo sin las cabeceras)", () => {
    expect(isCrossSite(req({ origin: ALLOWED, "sec-fetch-site": "same-origin" }), ALLOWED)).toBe(
      false,
    );
    expect(isCrossSite(req({}), ALLOWED)).toBe(false);
    // El propio servidor (un dominio distinto de DASHBOARD_URL, como www o un preview).
    expect(isCrossSite(req({ origin: "https://holarocco.com" }), "https://caja.example.com")).toBe(
      false,
    );
  });
});
