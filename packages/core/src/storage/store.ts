/**
 * Almacenamiento de objetos para fotos de facturas (US-B6): bucket privado, URLs firmadas de
 * corta vida generadas en servidor. Interfaz propia; Supabase Storage por REST sin SDK.
 */
export interface ObjectStore {
  readonly provider: string;
  put(key: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  delete(key: string): Promise<void>;
  signedUrl(key: string, expiresInSeconds: number): Promise<string>;
}

export class StorageError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
  ) {
    super(message);
    this.name = "StorageError";
  }
}

export type SupabaseStorageOptions = {
  /** URL del proyecto, p. ej. https://xxxx.supabase.co */
  url: string;
  /** Clave service_role: solo en el worker y en el servidor de Next, nunca en el navegador. */
  serviceKey: string;
  bucket: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class SupabaseStorage implements ObjectStore {
  readonly provider = "supabase";
  readonly #base: string;
  readonly #key: string;
  readonly #bucket: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(opts: SupabaseStorageOptions) {
    this.#base = `${opts.url.replace(/\/$/, "")}/storage/v1`;
    this.#key = opts.serviceKey;
    this.#bucket = opts.bucket;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? 20_000;
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.#key}`, apikey: this.#key, ...extra };
  }

  async #call(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        ...init,
        method,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw new StorageError(`storage: ${err instanceof Error ? err.message : String(err)}`, null);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new StorageError(`storage ${res.status}: ${text.slice(0, 200)}`, res.status);
    }
    return res;
  }

  async put(key: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    await this.#call("POST", `/object/${this.#bucket}/${key}`, {
      headers: this.#headers({ "Content-Type": mimeType, "x-upsert": "false" }),
      body: new Blob([bytes as Uint8Array<ArrayBuffer>]),
    });
  }

  async delete(key: string): Promise<void> {
    await this.#call("DELETE", `/object/${this.#bucket}/${key}`, { headers: this.#headers() });
  }

  async signedUrl(key: string, expiresInSeconds: number): Promise<string> {
    const res = await this.#call("POST", `/object/sign/${this.#bucket}/${key}`, {
      headers: this.#headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ expiresIn: expiresInSeconds }),
    });
    const data = (await res.json()) as { signedURL?: string };
    if (!data.signedURL) throw new StorageError("storage: respuesta sin signedURL", null);
    return `${this.#base}${data.signedURL}`;
  }
}

/** Doble para tests: guarda en memoria. */
export class MemoryObjectStore implements ObjectStore {
  readonly provider = "memory";
  readonly objects = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  async put(key: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    this.objects.set(key, { bytes, mimeType });
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async signedUrl(key: string, expiresInSeconds: number): Promise<string> {
    return `memory://${key}?exp=${expiresInSeconds}`;
  }
}
