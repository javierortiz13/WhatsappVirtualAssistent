import { silentLogger, whatsapp } from "@caja/core";
import { describe, expect, it, vi } from "vitest";
import { handleInbound, handleVerify } from "../lib/webhook.js";

const secret = "s3cret";
const verifyToken = "verify-token-0123456789abcdef";

describe("GET verificación", () => {
  it("devuelve el challenge con el token correcto", () => {
    const req = new Request(
      `https://x/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=12345`,
    );
    const res = handleVerify(req, { verifyToken });
    expect(res.status).toBe(200);
  });
  it("403 con token incorrecto o parámetros faltantes", () => {
    expect(
      handleVerify(
        new Request("https://x/w?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1"),
        { verifyToken },
      ).status,
    ).toBe(403);
    expect(handleVerify(new Request("https://x/w"), { verifyToken }).status).toBe(403);
  });
});

describe("POST entrada", () => {
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  const deps = (ingest = vi.fn(async () => ({ db: {} as never, enqueue: vi.fn() }))) => ({
    appSecret: secret,
    verifyToken,
    log: silentLogger,
    ingest,
  });

  it("401 sin firma o con firma inválida, y no toca la base", async () => {
    const ingest = vi.fn();
    const d = deps(ingest as never);
    const r1 = await handleInbound(new Request("https://x/w", { method: "POST", body }), d);
    expect(r1.status).toBe(401);
    const r2 = await handleInbound(
      new Request("https://x/w", {
        method: "POST",
        body,
        headers: { "x-hub-signature-256": "sha256=00" },
      }),
      d,
    );
    expect(r2.status).toBe(401);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("200 con firma válida y payload vacío", async () => {
    const res = await handleInbound(
      new Request("https://x/w", {
        method: "POST",
        body,
        headers: { "x-hub-signature-256": whatsapp.signBody(body, secret) },
      }),
      deps(),
    );
    expect(res.status).toBe(200);
  });

  it("500 si la ingesta falla por base o cola, para que Meta reintente", async () => {
    const d = deps(
      vi.fn(async () => ({
        db: { transaction: () => Promise.reject(new Error("db down")) } as never,
        enqueue: vi.fn(),
      })),
    );
    const payload = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: "P" },
                messages: [
                  { from: "58412", id: "w1", timestamp: "1", type: "text", text: { body: "hola" } },
                ],
              },
            },
          ],
        },
      ],
    });
    const res = await handleInbound(
      new Request("https://x/w", {
        method: "POST",
        body: payload,
        headers: { "x-hub-signature-256": whatsapp.signBody(payload, secret) },
      }),
      d,
    );
    expect(res.status).toBe(500);
  });

  it("200 e ignorado si el JSON firmado tiene una forma desconocida", async () => {
    const weird = JSON.stringify({ nope: true });
    const res = await handleInbound(
      new Request("https://x/w", {
        method: "POST",
        body: weird,
        headers: { "x-hub-signature-256": whatsapp.signBody(weird, secret) },
      }),
      deps(),
    );
    expect(res.status).toBe(200);
  });
});
