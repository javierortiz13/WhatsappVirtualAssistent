import { type IngestDeps, ingestWebhook, type Logger, whatsapp } from "@caja/core";

/**
 * Lógica del webhook separada de Next para poder probarla con `Request` estándar.
 * GET: verificación de Meta. POST: firma sobre el cuerpo crudo, ingesta, 200 en milisegundos.
 */
export type WebhookDeps = {
  appSecret: string;
  verifyToken: string;
  ingest: () => Promise<IngestDeps>;
  log: Logger;
};

export function handleVerify(req: Request, deps: Pick<WebhookDeps, "verifyToken">): Response {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token && challenge && safeEqual(token, deps.verifyToken)) {
    return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
  }
  return new Response("forbidden", { status: 403 });
}

export async function handleInbound(req: Request, deps: WebhookDeps): Promise<Response> {
  const raw = await req.text();
  const signature = req.headers.get("x-hub-signature-256");
  if (!whatsapp.verifySignature(raw, signature, deps.appSecret)) {
    deps.log.warn({ hasSignature: Boolean(signature) }, "firma de webhook inválida");
    return new Response("invalid signature", { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Firmado por Meta pero no es JSON: no reintentar.
    return new Response("bad json", { status: 200 });
  }
  try {
    const result = await ingestWebhook(await deps.ingest(), payload);
    deps.log.info(result, "webhook procesado");
    return Response.json({ ok: true });
  } catch (err) {
    if (err instanceof Error && err.name === "ZodError") {
      deps.log.warn({ err: err.message }, "webhook con forma desconocida");
      return new Response("ignored", { status: 200 });
    }
    deps.log.error({ err: err instanceof Error ? err.message : String(err) }, "ingesta falló");
    // Base o cola caídas: 500 para que Meta reintente (ADR-004).
    return new Response("temporarily unavailable", { status: 500 });
  }
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
