/** Logger mínimo que cualquier implementación (pino, console) satisface. Nunca recibe cuerpos de mensajes. */
export interface Logger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Enmascara un número: 58412****567. */
export function maskPhone(e164: string | null | undefined): string {
  if (!e164) return "?";
  if (e164.length <= 7) return `${e164.slice(0, 2)}***`;
  return `${e164.slice(0, 5)}****${e164.slice(-3)}`;
}
