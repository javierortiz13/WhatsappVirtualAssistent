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

/**
 * Quita de un texto de error lo que puede ser del usuario (ER-3, revisión de hábitos): Drizzle
 * agrega los parámetros de la consulta ("params: …") y Postgres la fila ("Failing row contains
 * (…)") o la llave ("Key (x)=(…)"). Ahí puede ir el texto de un mensaje. La consulta en sí queda:
 * sus valores van aparte, como parámetros.
 */
export function scrubErrorText(text: string): string {
  return text
    .replace(/\s*params:[\s\S]*$/i, "\nparams: [omitidos]")
    .replace(/Failing row contains \([\s\S]*?\)(?=\.?\s|\.?$)/g, "Failing row contains (…)")
    .replace(/Key \(([^)]*)\)=\([^)]*\)/g, "Key ($1)=(…)");
}

/** El mensaje de un error, sin datos del usuario. */
export function errorText(err: unknown): string {
  return scrubErrorText(err instanceof Error ? err.message : String(err));
}

/** Para el logger: recorta los campos de error de cada línea (`err`, `error`, `detail`). */
export function scrubLogFields(obj: Record<string, unknown>): Record<string, unknown> {
  const out = { ...obj };
  for (const k of ["err", "error", "detail", "msg"])
    if (typeof out[k] === "string") out[k] = scrubErrorText(out[k] as string);
  return out;
}

type SentryLikeEvent = {
  message?: string;
  exception?: { values?: { value?: string }[] };
  breadcrumbs?: { message?: string }[];
};

/**
 * `beforeSend` de Sentry (worker, servidor web y navegador; SEC-1): el mismo recorte en el mensaje,
 * en cada excepción y en los breadcrumbs.
 */
export function scrubSentryEvent<E extends SentryLikeEvent>(event: E): E {
  if (event.message) event.message = scrubErrorText(event.message);
  for (const v of event.exception?.values ?? []) if (v.value) v.value = scrubErrorText(v.value);
  for (const b of event.breadcrumbs ?? []) if (b.message) b.message = scrubErrorText(b.message);
  return event;
}
