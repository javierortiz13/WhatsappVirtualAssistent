import { describe, expect, it } from "vitest";
import { type AiaDeps, fetchWithAia, isMissingIntermediate, toPem } from "../src/rates/aia";

/** El BCV sin certificado intermedio (04/10): se completa por AIA y la petición se repite. */
const leafError = () =>
  new TypeError("fetch failed", {
    cause: Object.assign(new Error("unable to verify the first certificate"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    }),
  });

function deps(over: Partial<AiaDeps> = {}) {
  const calls = { fetch: 0, issuer: 0, download: 0, withCa: [] as string[] };
  const d: AiaDeps = {
    fetch: async () => {
      calls.fetch += 1;
      throw leafError();
    },
    issuerUrl: async () => {
      calls.issuer += 1;
      return "http://crt.example/intermedio.crt";
    },
    download: async () => {
      calls.download += 1;
      return new Uint8Array([0x30, 0x82, 0x01, 0x0a]);
    },
    getWithCa: async (_url, ca) => {
      calls.withCa.push(ca);
      return new Response("<html>ok</html>", { status: 200 });
    },
    ...over,
  };
  return { d, calls };
}

describe("AIA para el BCV", () => {
  it("reconoce el error de cadena incompleta", () => {
    expect(isMissingIntermediate(leafError())).toBe(true);
    expect(isMissingIntermediate(new Error("HTTP 500"))).toBe(false);
  });

  it("DER a PEM; un PEM pasa igual", () => {
    expect(toPem(new Uint8Array([0x30, 0x82, 0x01, 0x0a]))).toBe(
      "-----BEGIN CERTIFICATE-----\nMIIBCg==\n-----END CERTIFICATE-----\n",
    );
    const pem = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n";
    expect(toPem(new TextEncoder().encode(pem))).toBe(pem);
  });

  it("sin intermedio: lo descarga, repite con él y lo recuerda", async () => {
    const { d, calls } = deps();
    const f = fetchWithAia(d);
    const res = await f("https://www.bcv.org.ve/", { headers: { accept: "text/html" } });
    expect(await res.text()).toBe("<html>ok</html>");
    expect(calls).toMatchObject({ fetch: 1, issuer: 1, download: 1 });
    expect(calls.withCa[0]).toContain("BEGIN CERTIFICATE");
    await f("https://www.bcv.org.ve/");
    expect(calls).toMatchObject({ fetch: 1, issuer: 1, download: 1 });
    expect(calls.withCa).toHaveLength(2);
  });

  it("otros errores, o sin dirección del intermedio, se lanzan como venían", async () => {
    const other = deps({
      fetch: async () => {
        throw new Error("ECONNRESET");
      },
    });
    await expect(fetchWithAia(other.d)("https://www.bcv.org.ve/")).rejects.toThrow("ECONNRESET");
    expect(other.calls.issuer).toBe(0);
    const noIssuer = deps({ issuerUrl: async () => null });
    await expect(fetchWithAia(noIssuer.d)("https://www.bcv.org.ve/")).rejects.toThrow(
      "fetch failed",
    );
  });

  it("si la página responde normal, no toca nada", async () => {
    const { d, calls } = deps({ fetch: async () => new Response("bien", { status: 200 }) });
    expect(await (await fetchWithAia(d)("https://www.bcv.org.ve/")).text()).toBe("bien");
    expect(calls.issuer).toBe(0);
  });
});
