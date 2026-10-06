/**
 * Cliente mínimo de la WhatsApp Cloud API (Graph API) con `fetch`. El SDK oficial de Node está
 * archivado desde 2023. Valida los límites de la API antes de enviar para fallar en tests y no
 * en producción. No reintenta: eso lo decide el worker según `MetaApiError.retryable`.
 */
export const LIMITS = {
  textBody: 4096,
  interactiveBody: 1024,
  buttons: 3,
  buttonTitle: 20,
  listButton: 20,
  listSections: 10,
  listRows: 10,
  sectionTitle: 24,
  rowTitle: 24,
  rowDescription: 72,
} as const;

export type Button = { id: string; title: string };
export type ListRow = { id: string; title: string; description?: string };
export type ListSection = { title?: string; rows: ListRow[] };

export type MediaInfo = {
  id: string;
  url: string;
  mimeType: string;
  sha256: string | null;
  fileSize: number | null;
};

export class MetaApiError extends Error {
  readonly status: number;
  readonly code: number | null;
  readonly retryable: boolean;
  readonly details: unknown;
  constructor(message: string, status: number, code: number | null, details: unknown) {
    super(message);
    this.name = "MetaApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    // 429 y 5xx se reintentan; 4xx (número bloqueó, ventana cerrada, payload inválido) no.
    this.retryable = status === 429 || status >= 500;
  }
}

export class LimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimitError";
  }
}

export type MetaClientOptions = {
  accessToken: string;
  phoneNumberId: string;
  graphVersion?: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
};

type SendResult = { waMessageId: string };

export class MetaClient {
  readonly #token: string;
  readonly #phoneNumberId: string;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(opts: MetaClientOptions) {
    this.#token = opts.accessToken;
    this.#phoneNumberId = opts.phoneNumberId;
    const version = opts.graphVersion ?? "v24.0";
    this.#base = `${opts.baseUrl ?? "https://graph.facebook.com"}/${version}`;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? 15_000;
  }

  get phoneNumberId(): string {
    return this.#phoneNumberId;
  }

  async sendText(
    to: string,
    body: string,
    opts: { previewUrl?: boolean; replyTo?: string } = {},
  ): Promise<SendResult> {
    assertLen("texto", body, LIMITS.textBody);
    return this.#sendMessage(to, {
      type: "text",
      text: { body, preview_url: opts.previewUrl ?? false },
      ...(opts.replyTo ? { context: { message_id: opts.replyTo } } : {}),
    });
  }

  /**
   * Plantilla aprobada en WhatsApp Manager: la única forma de escribir fuera de la ventana de 24 h
   * (0017, avisos de borrado por impago). `params` llena {{1}}, {{2}}… del cuerpo.
   */
  async sendTemplate(
    to: string,
    name: string,
    languageCode: string,
    params: string[],
  ): Promise<SendResult> {
    return this.#sendMessage(to, {
      type: "template",
      template: {
        name,
        language: { code: languageCode },
        ...(params.length
          ? {
              components: [
                { type: "body", parameters: params.map((text) => ({ type: "text", text })) },
              ],
            }
          : {}),
      },
    });
  }

  async sendButtons(
    to: string,
    body: string,
    buttons: Button[],
    opts: { footer?: string } = {},
  ): Promise<SendResult> {
    assertLen("cuerpo", body, LIMITS.interactiveBody);
    if (buttons.length < 1 || buttons.length > LIMITS.buttons) {
      throw new LimitError(`entre 1 y ${LIMITS.buttons} botones; recibidos ${buttons.length}`);
    }
    for (const b of buttons) {
      assertLen(`título de botón "${b.title}"`, b.title, LIMITS.buttonTitle);
      assertLen("id de botón", b.id, 256);
    }
    return this.#sendMessage(to, {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        ...(opts.footer ? { footer: { text: opts.footer } } : {}),
        action: {
          buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })),
        },
      },
    });
  }

  async sendList(
    to: string,
    body: string,
    buttonLabel: string,
    sections: ListSection[],
    opts: { header?: string; footer?: string } = {},
  ): Promise<SendResult> {
    assertLen("cuerpo", body, LIMITS.interactiveBody);
    assertLen("etiqueta de lista", buttonLabel, LIMITS.listButton);
    if (sections.length < 1 || sections.length > LIMITS.listSections) {
      throw new LimitError(`entre 1 y ${LIMITS.listSections} secciones`);
    }
    const totalRows = sections.reduce((n, s) => n + s.rows.length, 0);
    if (totalRows < 1 || totalRows > LIMITS.listRows) {
      throw new LimitError(`entre 1 y ${LIMITS.listRows} filas en total; recibidas ${totalRows}`);
    }
    for (const s of sections) {
      if (s.title) assertLen("título de sección", s.title, LIMITS.sectionTitle);
      for (const r of s.rows) {
        assertLen(`título de fila "${r.title}"`, r.title, LIMITS.rowTitle);
        if (r.description) assertLen("descripción de fila", r.description, LIMITS.rowDescription);
        assertLen("id de fila", r.id, 200);
      }
    }
    return this.#sendMessage(to, {
      type: "interactive",
      interactive: {
        type: "list",
        ...(opts.header ? { header: { type: "text", text: opts.header } } : {}),
        body: { text: body },
        ...(opts.footer ? { footer: { text: opts.footer } } : {}),
        action: {
          button: buttonLabel,
          sections: sections.map((s) => ({
            ...(s.title ? { title: s.title } : {}),
            rows: s.rows.map((r) => ({
              id: r.id,
              title: r.title,
              ...(r.description ? { description: r.description } : {}),
            })),
          })),
        },
      },
    });
  }

  /** Reacción con un emoji sobre un mensaje del usuario. Gratis, no cuenta como mensaje de servicio. */
  async sendReaction(to: string, waMessageId: string, emoji: string): Promise<SendResult> {
    return this.#sendMessage(to, {
      type: "reaction",
      reaction: { message_id: waMessageId, emoji },
    });
  }

  /** Marca como leído y muestra "escribiendo…" hasta que respondamos o pasen 25 s. Solo si vamos a responder. */
  async markReadWithTyping(waMessageId: string): Promise<void> {
    await this.#post(`/${this.#phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: waMessageId,
      typing_indicator: { type: "text" },
    });
  }

  async markRead(waMessageId: string): Promise<void> {
    await this.#post(`/${this.#phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: waMessageId,
    });
  }

  /** La URL devuelta vence a los 5 minutos y requiere el token para descargarla. */
  async getMediaInfo(mediaId: string): Promise<MediaInfo> {
    const r = (await this.#get(`/${mediaId}`)) as {
      id?: string;
      url: string;
      mime_type: string;
      sha256?: string;
      file_size?: number;
    };
    return {
      id: r.id ?? mediaId,
      url: r.url,
      mimeType: r.mime_type,
      sha256: r.sha256 ?? null,
      fileSize: r.file_size ?? null,
    };
  }

  async downloadMedia(
    url: string,
    maxBytes: number,
  ): Promise<{ bytes: Uint8Array; mimeType: string | null }> {
    const res = await this.#fetch(url, {
      headers: { Authorization: `Bearer ${this.#token}` },
      signal: AbortSignal.timeout(this.#timeoutMs * 2),
    });
    if (!res.ok)
      throw new MetaApiError(`descarga de medio falló: ${res.status}`, res.status, null, null);
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > maxBytes)
      throw new LimitError(`medio de ${len} bytes supera el máximo de ${maxBytes}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes)
      throw new LimitError(`medio de ${buf.byteLength} bytes supera el máximo de ${maxBytes}`);
    return { bytes: buf, mimeType: res.headers.get("content-type") };
  }

  async #sendMessage(to: string, message: Record<string, unknown>): Promise<SendResult> {
    const r = (await this.#post(`/${this.#phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      ...message,
    })) as { messages?: { id: string }[] };
    const id = r.messages?.[0]?.id;
    if (!id) throw new MetaApiError("respuesta sin id de mensaje", 502, null, r);
    return { waMessageId: id };
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    return this.#request("POST", path, body);
  }

  async #get(path: string): Promise<unknown> {
    return this.#request("GET", path, undefined);
  }

  async #request(method: "GET" | "POST", path: string, body: unknown): Promise<unknown> {
    const res = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const err = (json as { error?: { message?: string; code?: number } } | null)?.error;
      throw new MetaApiError(
        err?.message ?? `Meta respondió ${res.status}`,
        res.status,
        err?.code ?? null,
        json,
      );
    }
    return json;
  }
}

function assertLen(what: string, value: string, max: number): void {
  if (value.length === 0) throw new LimitError(`${what} vacío`);
  if (value.length > max)
    throw new LimitError(`${what} supera ${max} caracteres (${value.length})`);
}
