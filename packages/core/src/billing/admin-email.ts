/**
 * Correo al administrador con Resend (pagos por verificar, 19/11). Cliente mínimo con `fetch`,
 * como el de Meta: un solo destinatario, solo texto plano, sin reintentos.
 *
 * El error nunca lleva la respuesta de Resend: puede repetir el correo del destinatario, y el
 * error termina en Sentry. Solo el código HTTP.
 */

export type AdminMail = { subject: string; text: string };

export interface AdminMailer {
  send(mail: AdminMail): Promise<void>;
}

export class AdminEmailError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`el correo al administrador no salió (HTTP ${status})`);
    this.name = "AdminEmailError";
    this.status = status;
  }
}

export class ResendMailer implements AdminMailer {
  private readonly apiKey: string;
  private readonly from: string;
  private readonly to: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { apiKey: string; from: string; to: string; fetchImpl?: typeof fetch }) {
    this.apiKey = opts.apiKey;
    this.from = opts.from;
    this.to = opts.to;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async send(mail: AdminMail): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: this.from,
          to: [this.to],
          subject: mail.subject,
          text: mail.text,
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new AdminEmailError(0);
    }
    if (!res.ok) throw new AdminEmailError(res.status);
  }
}
