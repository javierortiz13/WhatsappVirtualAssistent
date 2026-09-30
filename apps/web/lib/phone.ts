/** Códigos de país del formulario. Venezuela primero; el resto, los más comunes en el piloto. */
export const COUNTRY_CODES = [
  { code: "58", label: "🇻🇪 +58" },
  { code: "1", label: "🇺🇸 +1" },
  { code: "57", label: "🇨🇴 +57" },
  { code: "34", label: "🇪🇸 +34" },
  { code: "507", label: "🇵🇦 +507" },
  { code: "56", label: "🇨🇱 +56" },
  { code: "51", label: "🇵🇪 +51" },
] as const;

/**
 * Convierte "+58" + "0412-123.45.67" en "584121234567" (E.164 sin '+'). Quita el cero inicial
 * de los números nacionales venezolanos. Devuelve null si no queda un número razonable.
 */
export function toE164(countryCode: string, local: string): string | null {
  const cc = countryCode.replace(/\D/g, "");
  let digits = local.replace(/\D/g, "");
  if (!cc || !digits) return null;
  if (digits.startsWith(cc) && digits.length > 10) digits = digits.slice(cc.length);
  if (cc === "58" && digits.startsWith("0")) digits = digits.slice(1);
  const e164 = `${cc}${digits}`;
  if (!/^\d{10,15}$/.test(e164)) return null;
  if (cc === "58" && digits.length !== 10) return null;
  return e164;
}

/** "584121234567" → "+58 412 1234567" para mostrar. */
export function formatE164(e164: string): string {
  const cc = COUNTRY_CODES.find((c) => e164.startsWith(c.code))?.code;
  if (!cc) return `+${e164}`;
  const rest = e164.slice(cc.length);
  return `+${cc} ${rest.slice(0, 3)} ${rest.slice(3)}`.trim();
}
