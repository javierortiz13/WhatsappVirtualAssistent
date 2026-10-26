import { scrubLogFields } from "@caja/core";
import pino from "pino";

export function createLogger(level: string, pretty: boolean) {
  return pino({
    level,
    // Nunca registrar cuerpos de mensajes ni tokens (Fase 7). Los números se enmascaran donde se usan.
    redact: ["*.body", "*.access_token", "*.authorization", "req.headers.authorization"],
    // Un error de la base trae los parámetros de la consulta (texto de mensajes): se recorta (ER-3).
    formatters: { log: (obj) => scrubLogFields(obj) },
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
  });
}
