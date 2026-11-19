import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/api/ref` (US-420, SEC-P4-6, SEC-P4-12) y `referralsOn()` guardado 30 s (seguridad F6). La base
 * es falsa: solo devuelve los interruptores `habits` y cuenta cuántas veces se le preguntó.
 */
const state = vi.hoisted(() => ({ flags: { xp: false, referrals: false }, reads: 0 }));

vi.mock("server-only", () => ({}));
vi.mock("../lib/db", () => ({
  db: () => ({
    select: () => ({
      from: () => ({
        where: async () => {
          state.reads += 1;
          return [{ value: { ...state.flags } }];
        },
      }),
    }),
  }),
}));

const { GET } = await import("../app/api/ref/route");
const { forgetReferralsOn, referralsOn, REFERRALS_ON_TTL_MS } = await import("../lib/referral");

const ref = (q: string) => GET(new NextRequest(`https://holarocco.com/api/ref?${q}`));

describe("/api/ref", () => {
  beforeEach(() => {
    forgetReferralsOn();
    state.reads = 0;
    state.flags = { xp: false, referrals: false };
  });

  it("referrals apagado: 302 a next, sin Set-Cookie y sin caché", async () => {
    const res = await ref("code=RK4M7Q&next=%2F%3Fx%3D1");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://holarocco.com/?x=1");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("encendido + código válido: rocco_ref (HttpOnly, Secure, Lax, 30 días) en ese 302", async () => {
    state.flags = { xp: true, referrals: true };
    const res = await ref("code=rk4m7q&next=%2F");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://holarocco.com/");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^rocco_ref=RK4M7Q;/);
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/;\s*SameSite=Lax/i);
    expect(cookie).toMatch(/;\s*Path=\//i);
    expect(cookie).toMatch(/;\s*Max-Age=2592000/i);
  });

  it("encendido + código mal formado o sin código: sin cookie", async () => {
    state.flags = { xp: true, referrals: true };
    for (const q of ["code=RK4M7O", "code=RK4M7Q%0D%0ALocation:x", "code=PRUEBA", "next=%2F"]) {
      const res = await ref(q);
      expect(res.status, q).toBe(302);
      expect(res.headers.get("set-cookie"), q).toBeNull();
      expect(res.headers.get("cache-control"), q).toBe("private, no-store");
    }
  });

  it("`xp` apagado con `referrals` encendido: sin cookie", async () => {
    state.flags = { xp: false, referrals: true };
    const res = await ref("code=RK4M7Q");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("next «//evil», «/\\evil» o absoluto → «/» de este sitio", async () => {
    state.flags = { xp: true, referrals: true };
    for (const next of ["//evil.example/x", "/\\evil.example", "https://evil.example/", "evil"]) {
      const res = await ref(`code=RK4M7Q&next=${encodeURIComponent(next)}`);
      expect(res.status, next).toBe(302);
      expect(res.headers.get("location"), next).toBe("https://holarocco.com/");
      expect(res.headers.get("cache-control"), next).toBe("private, no-store");
    }
  });
});

describe("referralsOn() (seguridad F6)", () => {
  beforeEach(() => {
    forgetReferralsOn();
    state.reads = 0;
    state.flags = { xp: true, referrals: true };
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => vi.useRealTimers());

  it("dos llamadas en 30 s → una consulta; después de 30 s, otra", async () => {
    expect(await referralsOn()).toBe(true);
    state.flags = { xp: true, referrals: false };
    vi.advanceTimersByTime(REFERRALS_ON_TTL_MS - 1);
    expect(await referralsOn()).toBe(true);
    expect(state.reads).toBe(1);
    vi.advanceTimersByTime(1);
    expect(await referralsOn()).toBe(false);
    expect(state.reads).toBe(2);
  });

  it("/w, /api/ref y ?ref= seguidos dentro de 30 s: una sola lectura", async () => {
    await ref("code=RK4M7Q");
    await ref("code=K7M2QX");
    await referralsOn();
    expect(state.reads).toBe(1);
  });

  it("al guardar los interruptores desde /admin, se olvida", async () => {
    await referralsOn();
    forgetReferralsOn();
    await referralsOn();
    expect(state.reads).toBe(2);
  });
});
