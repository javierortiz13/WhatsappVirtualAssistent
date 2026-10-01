import { describe, expect, it } from "vitest";
import { DeepgramClient, SpeechError } from "../src/speech/client";

function fake(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("DeepgramClient", () => {
  it("manda el audio al endpoint con modelo, idioma y tipo, y lee transcripción, confianza y duración", async () => {
    const f = fake(
      () =>
        new Response(
          JSON.stringify({
            metadata: { duration: 7.4 },
            results: {
              channels: [
                { alternatives: [{ transcript: " veinte dólares de hielo ", confidence: 0.93 }] },
              ],
            },
          }),
          { status: 200 },
        ),
    );
    const c = new DeepgramClient({ apiKey: "K", fetchImpl: f.fetchImpl });
    const t = await c.transcribe(new Uint8Array([1, 2, 3]), "audio/ogg; codecs=opus");
    expect(t).toEqual({ text: "veinte dólares de hielo", confidence: 0.93, durationSeconds: 7.4 });
    const url = new URL(f.calls[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/listen");
    expect(url.searchParams.get("model")).toBe("nova-3");
    expect(url.searchParams.get("language")).toBe("es");
    const headers = f.calls[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Token K");
    expect(headers["Content-Type"]).toBe("audio/ogg");
  });

  it("error HTTP: SpeechError con estado y reintentable solo en 429/5xx", async () => {
    const c401 = new DeepgramClient({
      apiKey: "K",
      fetchImpl: fake(() => new Response("bad key", { status: 401 })).fetchImpl,
    });
    await expect(c401.transcribe(new Uint8Array(1), null)).rejects.toMatchObject({
      name: "SpeechError",
      status: 401,
      retryable: false,
    });
    const c503 = new DeepgramClient({
      apiKey: "K",
      fetchImpl: fake(() => new Response("x", { status: 503 })).fetchImpl,
    });
    await expect(c503.transcribe(new Uint8Array(1), null)).rejects.toBeInstanceOf(SpeechError);
  });

  it("respuesta sin transcripción devuelve texto vacío", async () => {
    const c = new DeepgramClient({
      apiKey: "K",
      fetchImpl: fake(() => new Response(JSON.stringify({ results: {} }), { status: 200 }))
        .fetchImpl,
    });
    expect(await c.transcribe(new Uint8Array(1), null)).toEqual({
      text: "",
      confidence: null,
      durationSeconds: null,
    });
  });
});
