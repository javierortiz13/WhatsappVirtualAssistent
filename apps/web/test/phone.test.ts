import { describe, expect, it } from "vitest";
import { formatE164, maskE164, parsePhoneRef, phoneRefPath, toE164 } from "../lib/phone";

describe("teléfonos del formulario", () => {
  it("normaliza números venezolanos con o sin cero inicial y con separadores", () => {
    expect(toE164("58", "0412-123.45.67")).toBe("584121234567");
    expect(toE164("58", "412 1234567")).toBe("584121234567");
    expect(toE164("+58", "+58 412 1234567")).toBe("584121234567");
  });
  it("rechaza números venezolanos que no tienen 10 dígitos y basura", () => {
    expect(toE164("58", "412 123")).toBeNull();
    expect(toE164("58", "")).toBeNull();
    expect(toE164("", "4121234567")).toBeNull();
  });
  it("acepta otros países por longitud total", () => {
    expect(toE164("1", "(786) 966-0391")).toBe("17869660391");
    expect(toE164("34", "612345678")).toBe("34612345678");
  });
  it("formatea para mostrar", () => {
    expect(formatE164("584121234567")).toBe("+58 412 1234567");
    expect(formatE164("17869660391")).toBe("+1 786 9660391");
  });
});

describe("maskE164 (admin, 08/11)", () => {
  it("deja el país, el primer dígito y los dos últimos", () => {
    expect(maskE164("584121234567")).toBe("+58 4•• ••• •• 67");
    expect(maskE164("17869660391")).toBe("+1 7•• ••• •• 91");
    expect(maskE164("50761234567")).toBe("+507 6•• ••• •• 67");
    expect(maskE164("584121234567")).not.toContain("1234");
  });
});

describe("enlaces de teléfono del admin (A-2)", () => {
  const A = "6f1c2a3b-4d5e-4f60-8a71-b2c3d4e5f607";
  const B = "7a2d3b4c-5e6f-4a70-9b81-c3d4e5f60718";
  it("signup/<id> y telefono/<negocio>/<teléfono>, ida y vuelta", () => {
    expect(parsePhoneRef(["signup", A])).toEqual({ kind: "signup", id: A });
    expect(parsePhoneRef(["telefono", A, B])).toEqual({ kind: "phone", tenantId: A, phoneId: B });
    expect(phoneRefPath({ kind: "phone", tenantId: A, phoneId: B })).toBe(`telefono/${A}/${B}`);
    expect(parsePhoneRef(phoneRefPath({ kind: "signup", id: A }).split("/"))).toEqual({
      kind: "signup",
      id: A,
    });
  });
  it("cualquier otra cosa no es un enlace válido", () => {
    for (const parts of [
      ["signup"],
      ["signup", "584121234567"],
      ["telefono", A],
      ["telefono", A, "x"],
      ["otro", A],
      ["signup", A, B],
    ])
      expect(parsePhoneRef(parts), parts.join("/")).toBeNull();
  });
});
