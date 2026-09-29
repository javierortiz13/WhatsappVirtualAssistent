import pino from "pino";

export function createLogger(level: string, pretty: boolean) {
  return pino({
    level,
    // Nunca registrar cuerpos de mensajes ni tokens (Fase 7). Los números se enmascaran donde se usan.
    redact: ["*.body", "*.access_token", "*.authorization", "req.headers.authorization"],
    ...(pretty ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
  });
}
