import { Buffer } from "node:buffer";
import https from "node:https";
import tls from "node:tls";
import zlib from "node:zlib";

/**
 * bcv.org.ve no manda su certificado intermedio: Node rechaza la conexión con
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE (confirmado en producción el 04/10/2026; el BCV falló en cada
 * intento desde el 30/09). Los navegadores lo resuelven descargando el intermedio de la dirección
 * que trae el propio certificado (AIA, "CA Issuers"). Aquí se hace lo mismo y la petición se repite
 * con ese intermedio junto a las raíces de siempre: la cadena se sigue verificando completa hasta
 * una raíz de confianza. Solo para leer la dirección del intermedio se abre una conexión sin
 * verificar, y de ella no se usa ningún dato de la página.
 */
const CHAIN_ERRORS = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);

export function isMissingIntermediate(err: unknown): boolean {
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && CHAIN_ERRORS.has(code);
}

/** DER (binario) → PEM. Si ya viene en PEM, se devuelve tal cual. */
export function toPem(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString("latin1");
  if (text.includes("-----BEGIN CERTIFICATE-----")) return text;
  const b64 = Buffer.from(bytes).toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

export type AiaDeps = {
  /** El intento normal. */
  fetch: typeof fetch;
  /** Dirección "CA Issuers" del certificado del servidor; null si no trae. */
  issuerUrl: (host: string) => Promise<string | null>;
  /** Descarga el intermedio (suele ser http y DER). */
  download: (url: string) => Promise<Uint8Array>;
  /** GET verificado con las raíces del sistema más `extraCa`. */
  getWithCa: (url: string, extraCa: string, headers: Record<string, string>) => Promise<Response>;
};

export const nodeAiaDeps: AiaDeps = {
  fetch: (input, init) => fetch(input, init),
  issuerUrl: (host) =>
    new Promise((resolve) => {
      const socket = tls.connect(
        { host, port: 443, servername: host, rejectUnauthorized: false },
        () => {
          const cert = socket.getPeerCertificate(false) as tls.PeerCertificate & {
            infoAccess?: Record<string, string[]>;
          };
          socket.end();
          resolve(cert.infoAccess?.["CA Issuers - URI"]?.[0] ?? null);
        },
      );
      socket.setTimeout(10_000, () => {
        socket.destroy();
        resolve(null);
      });
      socket.on("error", () => resolve(null));
    }),
  download: async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`intermedio HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
  getWithCa: (url, extraCa, headers) =>
    new Promise((resolve, reject) => {
      const req = https.get(
        url,
        { ca: [...tls.rootCertificates, extraCa], headers, timeout: 20_000 },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            try {
              resolve(
                new Response(
                  new Uint8Array(decode(Buffer.concat(chunks), res.headers["content-encoding"])),
                  {
                    status: res.statusCode ?? 500,
                    headers: { "content-type": String(res.headers["content-type"] ?? "text/html") },
                  },
                ),
              );
            } catch (err) {
              reject(err);
            }
          });
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error("tiempo agotado")));
      req.on("error", reject);
    }),
};

/** `https` no descomprime como `fetch`: gzip, deflate o br según el encabezado. */
function decode(body: Buffer, encoding: string | undefined): Buffer {
  const e = (encoding ?? "").toLowerCase();
  if (e.includes("gzip")) return zlib.gunzipSync(body);
  if (e.includes("deflate")) return zlib.inflateSync(body);
  if (e.includes("br")) return zlib.brotliDecompressSync(body);
  return body;
}

/**
 * `fetch` que, si el servidor no manda su intermedio, lo busca por AIA y repite la petición con
 * él. El intermedio queda en memoria para las consultas siguientes.
 */
export function fetchWithAia(deps: AiaDeps = nodeAiaDeps): typeof fetch {
  const cache = new Map<string, string>();
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const host = new URL(url).hostname;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const cached = cache.get(host);
    if (cached) return deps.getWithCa(url, cached, headers);
    try {
      return await deps.fetch(input, init);
    } catch (err) {
      if (!isMissingIntermediate(err)) throw err;
      const issuer = await deps.issuerUrl(host);
      if (!issuer) throw err;
      const pem = toPem(await deps.download(issuer));
      cache.set(host, pem);
      return deps.getWithCa(url, pem, headers);
    }
  }) as typeof fetch;
}
