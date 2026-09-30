import { describe, expect, it } from "vitest";
import { formatE164, toE164 } from "../lib/phone";

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
