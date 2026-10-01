/**
 * Voz a texto (US-B5). Interfaz propia para poder cambiar de proveedor (Deepgram principal,
 * Gemini de respaldo según la Fase 6) y para probar con un doble. El audio nunca se guarda:
 * va de la descarga a la transcripción en memoria y se descarta.
 */
export type Transcript = {
  text: string;
  /** 0..1 si el proveedor lo da. */
  confidence: number | null;
  durationSeconds: number | null;
};

export interface SpeechClient {
  readonly provider: string;
  transcribe(audio: Uint8Array, mimeType: string | null): Promise<Transcript>;
}

export class SpeechError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "SpeechError";
  }
}

export type DeepgramOptions = {
  apiKey: string;
  /** `es` por defecto; `es-419` si el modelo lo admite. */
  language?: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

type DeepgramResponse = {
  metadata?: { duration?: number };
  results?: {
    channels?: { alternatives?: { transcript?: string; confidence?: number }[] }[];
  };
};

/** Deepgram Nova-3 por HTTP, sin SDK: una petición con el audio en el cuerpo. */
export class DeepgramClient implements SpeechClient {
  readonly provider = "deepgram";
  readonly #key: string;
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(opts: DeepgramOptions) {
    this.#key = opts.apiKey;
    const params = new URLSearchParams({
      model: opts.model ?? "nova-3",
      language: opts.language ?? "es",
      smart_format: "true",
      punctuate: "true",
    });
    this.#url = `${opts.baseUrl ?? "https://api.deepgram.com"}/v1/listen?${params.toString()}`;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? 25_000;
  }

  async transcribe(audio: Uint8Array, mimeType: string | null): Promise<Transcript> {
    let res: Response;
    try {
      res = await this.#fetch(this.#url, {
        method: "POST",
        headers: {
          Authorization: `Token ${this.#key}`,
          "Content-Type": mimeType?.split(";")[0]?.trim() || "audio/ogg",
        },
        body: new Blob([audio as Uint8Array<ArrayBuffer>]),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw new SpeechError(
        `deepgram: ${err instanceof Error ? err.message : String(err)}`,
        null,
        true,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new SpeechError(
        `deepgram ${res.status}: ${text.slice(0, 200)}`,
        res.status,
        res.status === 429 || res.status >= 500,
      );
    }
    const data = (await res.json()) as DeepgramResponse;
    const alt = data.results?.channels?.[0]?.alternatives?.[0];
    return {
      text: (alt?.transcript ?? "").trim(),
      confidence: typeof alt?.confidence === "number" ? alt.confidence : null,
      durationSeconds: typeof data.metadata?.duration === "number" ? data.metadata.duration : null,
    };
  }
}
