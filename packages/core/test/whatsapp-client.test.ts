import { describe, expect, it } from "vitest";
import { LIMITS, LimitError, MetaApiError, MetaClient } from "../src/whatsapp/client";

type Call = { url: string; init: RequestInit };

function fakeFetch(
  handler: (call: Call) => { status: number; body: unknown; headers?: Record<string, string> },
) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    const r = handler(call);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
      status: r.status,
      headers: r.headers ?? { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetch: f, calls };
}

function client(f: typeof fetch) {
  return new MetaClient({
    accessToken: "TOKEN",
    phoneNumberId: "PNID",
    graphVersion: "v24.0",
    fetchImpl: f,
  });
}

const ok = { status: 200, body: { messages: [{ id: "wamid.OUT" }] } };

describe("MetaClient", () => {
  it("sendText envía el payload correcto con el token", async () => {
    const { fetch, calls } = fakeFetch(() => ok);
    const r = await client(fetch).sendText("584121234567", "Hola");
    expect(r.waMessageId).toBe("wamid.OUT");
    expect(calls[0]?.url).toBe("https://graph.facebook.com/v24.0/PNID/messages");
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer TOKEN");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "584121234567",
      type: "text",
      text: { body: "Hola", preview_url: false },
    });
  });

  it("sendButtons respeta los límites de Meta", async () => {
    const { fetch, calls } = fakeFetch(() => ok);
    const c = client(fetch);
    await c.sendButtons("1", "¿Guardar?", [
      { id: "confirm:1", title: "Guardar" },
      { id: "fix:1", title: "Corregir" },
      { id: "cancel:1", title: "Cancelar" },
    ]);
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.interactive.action.buttons).toHaveLength(3);
    expect(body.interactive.action.buttons[0]).toEqual({
      type: "reply",
      reply: { id: "confirm:1", title: "Guardar" },
    });
    await expect(c.sendButtons("1", "x", [])).rejects.toThrow(LimitError);
    await expect(
      c.sendButtons("1", "x", [
        { id: "a", title: "a" },
        { id: "b", title: "b" },
        { id: "c", title: "c" },
        { id: "d", title: "d" },
      ]),
    ).rejects.toThrow(/botones/);
    await expect(
      c.sendButtons("1", "x", [{ id: "a", title: "x".repeat(LIMITS.buttonTitle + 1) }]),
    ).rejects.toThrow(/20/);
  });

  it("sendList respeta filas, secciones y longitudes", async () => {
    const { fetch, calls } = fakeFetch(() => ok);
    const c = client(fetch);
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: `cat:${i}`,
      title: `Categoría ${i}`,
    }));
    await c.sendList("1", "¿Cuál?", "Ver categorías", [{ title: "Categorías", rows }]);
    expect(
      JSON.parse(String(calls[0]?.init.body)).interactive.action.sections[0].rows,
    ).toHaveLength(10);
    await expect(
      c.sendList("1", "x", "Ver", [{ rows: [...rows, { id: "x", title: "x" }] }]),
    ).rejects.toThrow(/filas/);
    await expect(
      c.sendList("1", "x", "Ver", [{ rows: [{ id: "x", title: "y".repeat(25) }] }]),
    ).rejects.toThrow(/24/);
    await expect(
      c.sendList("1", "x", "z".repeat(21), [{ rows: [{ id: "x", title: "y" }] }]),
    ).rejects.toThrow(/20/);
  });

  it("markReadWithTyping manda el indicador", async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, body: { success: true } }));
    await client(fetch).markReadWithTyping("wamid.IN");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: "wamid.IN",
      typing_indicator: { type: "text" },
    });
  });

  it("getMediaInfo y downloadMedia con límite de tamaño", async () => {
    const { fetch } = fakeFetch((call) =>
      call.url.endsWith("/MEDIA1")
        ? {
            status: 200,
            body: {
              url: "https://lookaside.example/m",
              mime_type: "audio/ogg",
              sha256: "s",
              file_size: 10,
            },
          }
        : {
            status: 200,
            body: "0123456789",
            headers: { "content-type": "audio/ogg", "content-length": "10" },
          },
    );
    const c = client(fetch);
    const info = await c.getMediaInfo("MEDIA1");
    expect(info).toEqual({
      id: "MEDIA1",
      url: "https://lookaside.example/m",
      mimeType: "audio/ogg",
      sha256: "s",
      fileSize: 10,
    });
    const media = await c.downloadMedia(info.url, 100);
    expect(media.bytes.byteLength).toBe(10);
    await expect(c.downloadMedia(info.url, 5)).rejects.toThrow(LimitError);
  });

  it("clasifica errores: 5xx y 429 reintentables, 4xx no", async () => {
    const { fetch: f500 } = fakeFetch(() => ({
      status: 503,
      body: { error: { message: "down", code: 2 } },
    }));
    await expect(client(f500).sendText("1", "x")).rejects.toMatchObject({
      name: "MetaApiError",
      status: 503,
      retryable: true,
    });
    const { fetch: f400 } = fakeFetch(() => ({
      status: 400,
      body: { error: { message: "bad", code: 131047 } },
    }));
    const err = await client(f400)
      .sendText("1", "x")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err).toMatchObject({ status: 400, code: 131047, retryable: false });
    const { fetch: f429 } = fakeFetch(() => ({
      status: 429,
      body: { error: { message: "rate" } },
    }));
    await expect(client(f429).sendText("1", "x")).rejects.toMatchObject({ retryable: true });
  });
});
