/**
 * Datos de pago móvil leídos de una foto (03/10): banco, teléfono y cédula o RIF del que cobra,
 * normalizados para pegarlos en la app del banco. Lo que no se entiende queda en null: nunca se
 * inventa un dígito.
 */
export type PagoMovilData = {
  bankCode: string | null;
  bankName: string | null;
  /** 11 dígitos: 04121234567. */
  phone: string | null;
  /** Letra (V, E, J, G, P) y dígitos, sin puntos. */
  idLetter: string | null;
  idNumber: string | null;
  holder: string | null;
};

/** Códigos de la Sudeban de los bancos que hacen pago móvil. */
export const BANKS: Record<string, string> = {
  "0102": "Banco de Venezuela",
  "0104": "Venezolano de Crédito",
  "0105": "Mercantil",
  "0108": "Provincial",
  "0114": "Bancaribe",
  "0115": "Banco Exterior",
  "0128": "Banco Caroní",
  "0134": "Banesco",
  "0137": "Sofitasa",
  "0138": "Banco Plaza",
  "0151": "BFC Banco Fondo Común",
  "0156": "100% Banco",
  "0157": "DelSur",
  "0163": "Banco del Tesoro",
  "0166": "Banco Agrícola de Venezuela",
  "0168": "Bancrecer",
  "0169": "R4 Banco Microfinanciero",
  "0171": "Banco Activo",
  "0172": "Bancamiga",
  "0174": "Banplus",
  "0175": "Banco Digital de los Trabajadores",
  "0177": "Banfanb",
  "0191": "BNC Banco Nacional de Crédito",
};

/** Nombres y apodos de uso común → código. Se busca como palabra dentro de lo leído. */
const BANK_ALIASES: [RegExp, string][] = [
  [/\bvenezolano de credito\b/, "0104"],
  [/\bmercantil\b/, "0105"],
  [/\b(provincial|bbva)\b/, "0108"],
  [/\bbancaribe\b/, "0114"],
  [/\bexterior\b/, "0115"],
  [/\bcaroni\b/, "0128"],
  [/\bbanesco\b/, "0134"],
  [/\bsofitasa\b/, "0137"],
  [/\bplaza\b/, "0138"],
  [/\b(bfc|fondo comun)\b/, "0151"],
  [/\b100 ?% ?banco\b/, "0156"],
  [/\bdel ?sur\b/, "0157"],
  [/\btesoro\b/, "0163"],
  [/\bagricola\b/, "0166"],
  [/\bbancrecer\b/, "0168"],
  [/\br4\b/, "0169"],
  [/\bactivo\b/, "0171"],
  [/\bbancamiga\b/, "0172"],
  [/\bbanplus\b/, "0174"],
  [/\b(bicentenario|digital de los trabajadores)\b/, "0175"],
  [/\bbanfanb\b/, "0177"],
  [/\b(bnc|nacional de credito)\b/, "0191"],
  // Al final: "venezuela" aparece en nombres de otros bancos.
  [/\b(banco de venezuela|bdv|venezuela)\b/, "0102"],
];

const plain = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** "0102 Banco de Venezuela", "Banesco", "0134" → código y nombre; lo que no se reconoce, tal cual. */
export function parseBank(raw: string): { code: string | null; name: string | null } {
  const t = raw.trim();
  if (!t) return { code: null, name: null };
  const code = /\b(01\d{2})\b/.exec(t)?.[1] ?? null;
  if (code && BANKS[code]) return { code, name: BANKS[code] };
  const p = plain(t);
  const alias = BANK_ALIASES.find(([re]) => re.test(p))?.[1];
  if (alias) return { code: alias, name: BANKS[alias] as string };
  return { code, name: t.slice(0, 60) };
}

/** "0412-302.02.56", "+58 412 3020256", "4123020256" → "04123020256"; null si no es un celular. */
export function parsePhone(raw: string): string | null {
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("58") && d.length === 12) d = `0${d.slice(2)}`;
  if (d.length === 10 && d.startsWith("4")) d = `0${d}`;
  return /^04\d{9}$/.test(d) ? d : null;
}

/** "V-25.871.244", "25871244", "J-40123456-7" → letra y dígitos; null si no se ve un documento. */
export function parseIdNumber(raw: string): { letter: string; number: string } | null {
  const t = raw.trim().toUpperCase();
  const letter = /\b([VEJGP])\s*[-.:]?\s*\d/.exec(t)?.[1] ?? "V";
  const digits = t.replace(/\D/g, "");
  if (digits.length < 6 || digits.length > 10) return null;
  return { letter, number: digits };
}

export function pagoMovilData(p: {
  bank: string;
  phone: string;
  id_number: string;
  holder: string;
}): PagoMovilData {
  const bank = parseBank(p.bank);
  const id = parseIdNumber(p.id_number);
  return {
    bankCode: bank.code,
    bankName: bank.name,
    phone: parsePhone(p.phone),
    idLetter: id?.letter ?? null,
    idNumber: id?.number ?? null,
    holder: p.holder.trim().slice(0, 60) || null,
  };
}

/** Un pago móvil se puede hacer con teléfono, cédula y banco; con dos de los tres ya sirve. */
export function isUsable(d: PagoMovilData): boolean {
  return [d.phone, d.idNumber, d.bankCode ?? d.bankName].filter(Boolean).length >= 2;
}
