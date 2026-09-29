import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifica `X-Hub-Signature-256` de Meta: HMAC-SHA256 del cuerpo crudo con el app secret.
 * El cuerpo debe ser exactamente los bytes recibidos (nunca el JSON reparseado).
 * Comparación en tiempo constante; cualquier malformación devuelve false, nunca lanza.
 */
export function signBody(rawBody: string | Uint8Array, appSecret: string): string {
  return `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
}

export function verifySignature(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !appSecret) return false;
  const expected = Buffer.from(signBody(rawBody, appSecret));
  const received = Buffer.from(signatureHeader.trim());
  if (expected.length !== received.length) return false;
  return timingSafeEqual(expected, received);
}
