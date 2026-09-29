import { describe, expect, it } from "vitest";
import { parseWebhook } from "../src/whatsapp/parse.js";
import * as fx from "./fixtures.js";

describe("parseWebhook", () => {
  it("texto", () => {
    const p = parseWebhook(fx.textMessage());
    expect(p.messages).toHaveLength(1);
    const m = p.messages[0];
    expect(m?.kind).toBe("text");
    expect(m?.sender).toEqual({ e164: "584121234567", waUserId: null, displayName: "Javier" });
    expect(m?.phoneNumberId).toBe(fx.PHONE_NUMBER_ID);
    expect(m?.timestamp.toISOString()).toBe("2025-09-30T00:00:00.000Z");
    if (m?.kind === "text") expect(m.text).toBe("gasté 15$ en champú");
  });
  it("nota de voz", () => {
    const m = parseWebhook(fx.audioMessage).messages[0];
    expect(m?.kind).toBe("audio");
    if (m?.kind === "audio") {
      expect(m.media).toEqual({
        id: "MEDIA_AUDIO",
        mimeType: "audio/ogg; codecs=opus",
        sha256: "abc",
      });
      expect(m.isVoiceNote).toBe(true);
    }
  });
  it("imagen con caption", () => {
    const m = parseWebhook(fx.imageMessage).messages[0];
    expect(m?.kind).toBe("image");
    if (m?.kind === "image") expect(m.caption).toBe("factura");
  });
  it("botón y lista", () => {
    const b = parseWebhook(fx.buttonReply).messages[0];
    expect(b?.kind).toBe("interactive");
    expect(b?.replyTo).toBe("wamid.PROMPT1");
    if (b?.kind === "interactive")
      expect([b.replyKind, b.replyId, b.replyTitle]).toEqual(["button", "confirm:pa-1", "Guardar"]);
    const l = parseWebhook(fx.listReply).messages[0];
    if (l?.kind === "interactive") expect([l.replyKind, l.replyId]).toEqual(["list", "cat:abc"]);
  });
  it("tipo no soportado se normaliza, no rompe", () => {
    const m = parseWebhook(fx.stickerMessage).messages[0];
    expect(m?.kind).toBe("unsupported");
    if (m?.kind === "unsupported") expect(m.rawType).toBe("sticker");
  });
  it("usuario con BSUID y sin número", () => {
    const m = parseWebhook(fx.bsuidMessage).messages[0];
    expect(m?.sender).toEqual({ e164: null, waUserId: "BSUID_XYZ", displayName: "María" });
  });
  it("estados: entregado sin errores, fallido con errores", () => {
    const d = parseWebhook(fx.deliveredStatus);
    expect(d.messages).toHaveLength(0);
    expect(d.statuses[0]?.status).toBe("delivered");
    expect(d.statuses[0]?.errors).toEqual([]);
    const f = parseWebhook(fx.failedStatus).statuses[0];
    expect(f?.errors[0]).toEqual({
      code: 131047,
      title: "Re-engagement message",
      details: "ventana de 24 h cerrada",
    });
  });
  it("cambios de otros campos se cuentan como ignorados", () => {
    expect(parseWebhook(fx.otherField).ignoredChanges).toBe(1);
  });
  it("sobre inválido lanza", () => {
    expect(() => parseWebhook({ hola: 1 })).toThrow();
  });
  it("varios mensajes en un webhook conservan el orden", () => {
    expect(parseWebhook(fx.twoMessages).messages.map((m) => m.waMessageId)).toEqual([
      "wamid.A",
      "wamid.B",
    ]);
  });
});
