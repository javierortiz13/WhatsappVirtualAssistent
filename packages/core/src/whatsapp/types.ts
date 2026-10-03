import { z } from "zod";

/**
 * Payload de webhook de la WhatsApp Cloud API (campo `messages`). Se valida de forma laxa:
 * solo lo que usamos es obligatorio; el resto pasa (`loose`) para no romper con campos nuevos.
 * Referencia: developers.facebook.com → Cloud API → Webhooks → Components.
 */
const Media = z
  .object({
    id: z.string(),
    mime_type: z.string().optional(),
    sha256: z.string().optional(),
    caption: z.string().optional(),
    filename: z.string().optional(),
    voice: z.boolean().optional(),
  })
  .loose();

export const InteractiveReply = z
  .object({
    type: z.enum(["button_reply", "list_reply"]),
    button_reply: z.object({ id: z.string(), title: z.string() }).loose().optional(),
    list_reply: z
      .object({ id: z.string(), title: z.string(), description: z.string().optional() })
      .loose()
      .optional(),
  })
  .loose();

export const RawMessage = z
  .object({
    from: z.string(),
    id: z.string(),
    timestamp: z.string(),
    type: z.string(),
    text: z.object({ body: z.string() }).loose().optional(),
    audio: Media.optional(),
    image: Media.optional(),
    document: Media.optional(),
    sticker: Media.optional(),
    video: Media.optional(),
    interactive: InteractiveReply.optional(),
    button: z.object({ payload: z.string(), text: z.string() }).loose().optional(),
    context: z
      .object({ from: z.string().optional(), id: z.string().optional() })
      .loose()
      .optional(),
    errors: z
      .array(z.object({ code: z.number().optional(), title: z.string().optional() }).loose())
      .optional(),
    user_id: z.string().optional(),
  })
  .loose();

export const RawStatus = z
  .object({
    id: z.string(),
    status: z.string(),
    timestamp: z.string(),
    recipient_id: z.string().optional(),
    errors: z
      .array(
        z
          .object({
            code: z.number().optional(),
            title: z.string().optional(),
            message: z.string().optional(),
            error_data: z.object({ details: z.string().optional() }).loose().optional(),
          })
          .loose(),
      )
      .optional(),
  })
  .loose();

export const RawContact = z
  .object({
    wa_id: z.string(),
    user_id: z.string().optional(),
    profile: z.object({ name: z.string().optional() }).loose().optional(),
  })
  .loose();

export const RawValue = z
  .object({
    messaging_product: z.literal("whatsapp"),
    metadata: z
      .object({ display_phone_number: z.string().optional(), phone_number_id: z.string() })
      .loose(),
    contacts: z.array(RawContact).optional(),
    messages: z.array(RawMessage).optional(),
    statuses: z.array(RawStatus).optional(),
    errors: z
      .array(z.object({ code: z.number().optional(), title: z.string().optional() }).loose())
      .optional(),
  })
  .loose();

export const WebhookPayload = z
  .object({
    object: z.string(),
    entry: z.array(
      z
        .object({
          id: z.string(),
          changes: z.array(z.object({ field: z.string(), value: z.unknown() }).loose()),
        })
        .loose(),
    ),
  })
  .loose();

export type RawMessage = z.infer<typeof RawMessage>;
export type RawStatus = z.infer<typeof RawStatus>;
export type RawValue = z.infer<typeof RawValue>;
export type WebhookPayload = z.infer<typeof WebhookPayload>;

/** Quién escribió: número E.164 sin '+' y/o identificador de usuario con ámbito de negocio (BSUID). */
export type Sender = { e164: string | null; waUserId: string | null; displayName: string | null };

export type InboundMedia = { id: string; mimeType: string | null; sha256: string | null };

export type InboundMessage = {
  waMessageId: string;
  phoneNumberId: string;
  sender: Sender;
  timestamp: Date;
  /** Id del mensaje al que responde (contexto), si lo hay. */
  replyTo: string | null;
} & (
  | { kind: "text"; text: string }
  | { kind: "audio"; media: InboundMedia; isVoiceNote: boolean }
  | { kind: "image"; media: InboundMedia; caption: string | null }
  | { kind: "document"; media: InboundMedia; filename: string | null; caption: string | null }
  | { kind: "interactive"; replyKind: "button" | "list"; replyId: string; replyTitle: string }
  | { kind: "unsupported"; rawType: string }
);

export type InboundStatus = {
  waMessageId: string;
  status: string;
  recipientId: string | null;
  timestamp: Date;
  errors: { code: number | null; title: string | null; details: string | null }[];
};

export type ParsedWebhook = {
  messages: InboundMessage[];
  statuses: InboundStatus[];
  /** Cambios que no son del campo `messages` o no validan; se cuentan, no se procesan. */
  ignoredChanges: number;
};
