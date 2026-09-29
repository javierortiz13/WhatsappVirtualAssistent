import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signBody, verifySignature } from "../src/whatsapp/signature";

const secret = "app-secret-de-prueba";
const body = '{"object":"whatsapp_business_account","entry":[]}';

describe("verifySignature", () => {
  it("acepta la firma correcta calculada sobre el cuerpo crudo", () => {
    const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifySignature(body, sig, secret)).toBe(true);
    expect(signBody(body, secret)).toBe(sig);
  });
  it("rechaza si el cuerpo cambió en un byte (JSON reparseado con espacios)", () => {
    const sig = signBody(body, secret);
    expect(verifySignature(`${body} `, sig, secret)).toBe(false);
  });
  it("rechaza secreto incorrecto, cabecera ausente o malformada, sin lanzar", () => {
    const sig = signBody(body, secret);
    expect(verifySignature(body, sig, "otro")).toBe(false);
    expect(verifySignature(body, null, secret)).toBe(false);
    expect(verifySignature(body, "", secret)).toBe(false);
    expect(verifySignature(body, "sha256=abc", secret)).toBe(false);
    expect(verifySignature(body, sig.replace("sha256=", "sha1="), secret)).toBe(false);
    expect(verifySignature(body, sig, "")).toBe(false);
  });
  it("funciona con bytes crudos (Uint8Array)", () => {
    const bytes = new TextEncoder().encode(body);
    expect(verifySignature(bytes, signBody(body, secret), secret)).toBe(true);
  });
});
