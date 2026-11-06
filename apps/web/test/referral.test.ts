import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { cleanCode, safeNext, waLink } from "../lib/referral-url";
import { proxy } from "../proxy";

/** Invitaciones en la web (P4-B, US-420, SEC-P4-2, SEC-P4-6, SEC-P4-10, SEC-P4-12). */
describe("enlaces de invitación", () => {
  it("/w/CODE: solo un código con la forma; nada de la ruta tal cual", () => {
    expect(cleanCode("rk4m7q")).toBe("RK4M7Q");
    for (const bad of [
      "RK4M7Q\n",
      "\rRK4M7Q",
      " RK4M7Q",
      "RK4M7QX",
      "RK 4M7",
      "RK4M7O",
      "PRUEBA",
      "",
    ])
      expect(cleanCode(bad), JSON.stringify(bad)).toBeNull();
    const ok = waLink("584121112233", cleanCode("RK4M7Q"), false);
    expect(ok).toBe("https://wa.me/584121112233?text=Hola%20Rocco%2C%20me%20invit%C3%B3%20RK4M7Q");
    const bad = waLink("584121112233", cleanCode("RK4M7Q\r\nLocation: x"), false);
    expect(bad).toBe("https://wa.me/584121112233?text=Hola%20Rocco");
  });
  it("sin invitación, el botón de la portada queda como hoy", () => {
    expect(waLink("584121112233", null, true)).toBe(
      "https://wa.me/584121112233?text=Hola%20Rocco&utm_source=landing&utm_medium=cta",
    );
  });
  it("la vuelta de /api/ref solo va a una ruta de este sitio", () => {
    expect(safeNext("/?x=1")).toBe("/?x=1");
    expect(safeNext("//evil.example/")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext(null)).toBe("/");
  });
  it("?ref= en una página: 302 a la misma ruta sin ref, sin caché y sin Set-Cookie", async () => {
    const res = await proxy(new NextRequest("https://holarocco.com/?x=1&ref=RK4M7Q"));
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    const to = new URL(res.headers.get("location") as string);
    expect(to.origin).toBe("https://holarocco.com");
    expect(to.pathname).toBe("/api/ref");
    expect(to.searchParams.get("code")).toBe("RK4M7Q");
    expect(to.searchParams.get("next")).toBe("/?x=1");
  });
});
