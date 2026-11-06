/**
 * Las partes puras de las invitaciones en la web (US-420, SEC-P4-10, SEC-P4-12), sin base ni
 * cookies, para probarlas solas.
 */

/** El alfabeto de §P4.7 (igual que `isCodeShape` del core y la regla de 0036). */
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

/** El código si tiene la forma de §P4.7 (en mayúsculas, al menos 2 dígitos), o null. */
export function cleanCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const code = raw.toUpperCase();
  return CODE_RE.test(code) && (code.match(/[0-9]/g)?.length ?? 0) >= 2 ? code : null;
}

/** Solo una ruta de este sitio ("/…", nunca "//…" ni "/\\…"): sin redirección abierta. */
export function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}

/** El enlace de WhatsApp de la plataforma, con «Hola Rocco» o «Hola Rocco, me invitó CODE». */
export function waLink(number: string, code: string | null, utm: boolean): string {
  const text = code ? `Hola Rocco, me invitó ${code}` : "Hola Rocco";
  const tail = utm ? "&utm_source=landing&utm_medium=cta" : "";
  return `https://wa.me/${encodeURIComponent(number)}?text=${encodeURIComponent(text)}${tail}`;
}
