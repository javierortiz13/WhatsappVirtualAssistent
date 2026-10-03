import {
  type InboundMessage,
  type ParsedWebhook,
  type RawMessage,
  type RawValue,
  RawValue as RawValueSchema,
  type Sender,
  WebhookPayload,
} from "./types";

/**
 * Normaliza un payload de webhook a mensajes y estados. Nunca lanza por contenido raro: lo que no
 * valida se cuenta en `ignoredChanges`. Lanza solo si el sobre externo no es un webhook.
 */
export function parseWebhook(payload: unknown): ParsedWebhook {
  const envelope = WebhookPayload.parse(payload);
  const out: ParsedWebhook = { messages: [], statuses: [], ignoredChanges: 0 };
  for (const entry of envelope.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages") {
        out.ignoredChanges += 1;
        continue;
      }
      const value = RawValueSchema.safeParse(change.value);
      if (!value.success) {
        out.ignoredChanges += 1;
        continue;
      }
      for (const m of value.data.messages ?? []) out.messages.push(toInbound(m, value.data));
      for (const s of value.data.statuses ?? []) {
        out.statuses.push({
          waMessageId: s.id,
          status: s.status,
          recipientId: s.recipient_id ?? null,
          timestamp: toDate(s.timestamp),
          errors: (s.errors ?? []).map((e) => ({
            code: e.code ?? null,
            title: e.title ?? null,
            details: e.error_data?.details ?? null,
          })),
        });
      }
    }
  }
  return out;
}

const DIGITS = /^\d{8,15}$/;

function senderOf(m: RawMessage, v: RawValue): Sender {
  const contact = (v.contacts ?? []).find(
    (c) => c.wa_id === m.from || (m.user_id && c.user_id === m.user_id),
  );
  const fromIsPhone = DIGITS.test(m.from);
  const e164 = fromIsPhone ? m.from : contact && DIGITS.test(contact.wa_id) ? contact.wa_id : null;
  const waUserId = m.user_id ?? contact?.user_id ?? (fromIsPhone ? null : m.from);
  return { e164, waUserId: waUserId ?? null, displayName: contact?.profile?.name ?? null };
}

function toDate(unixSeconds: string): Date {
  const n = Number(unixSeconds);
  return Number.isFinite(n) ? new Date(n * 1000) : new Date();
}

function toInbound(m: RawMessage, v: RawValue): InboundMessage {
  const base = {
    waMessageId: m.id,
    phoneNumberId: v.metadata.phone_number_id,
    sender: senderOf(m, v),
    timestamp: toDate(m.timestamp),
    replyTo: m.context?.id ?? null,
  };
  switch (m.type) {
    case "text":
      if (m.text) return { ...base, kind: "text", text: m.text.body };
      break;
    case "audio":
      if (m.audio)
        return {
          ...base,
          kind: "audio",
          media: {
            id: m.audio.id,
            mimeType: m.audio.mime_type ?? null,
            sha256: m.audio.sha256 ?? null,
          },
          isVoiceNote: m.audio.voice ?? false,
        };
      break;
    case "image":
      if (m.image)
        return {
          ...base,
          kind: "image",
          media: {
            id: m.image.id,
            mimeType: m.image.mime_type ?? null,
            sha256: m.image.sha256 ?? null,
          },
          caption: m.image.caption ?? null,
        };
      break;
    case "document":
      if (m.document)
        return {
          ...base,
          kind: "document",
          media: {
            id: m.document.id,
            mimeType: m.document.mime_type ?? null,
            sha256: m.document.sha256 ?? null,
          },
          filename: m.document.filename ?? null,
          caption: m.document.caption ?? null,
        };
      break;
    case "interactive": {
      const r = m.interactive;
      if (r?.type === "button_reply" && r.button_reply)
        return {
          ...base,
          kind: "interactive",
          replyKind: "button",
          replyId: r.button_reply.id,
          replyTitle: r.button_reply.title,
        };
      if (r?.type === "list_reply" && r.list_reply)
        return {
          ...base,
          kind: "interactive",
          replyKind: "list",
          replyId: r.list_reply.id,
          replyTitle: r.list_reply.title,
        };
      break;
    }
    case "button":
      // Respuesta a botón de plantilla (no se usa en el MVP, pero se normaliza igual).
      if (m.button)
        return {
          ...base,
          kind: "interactive",
          replyKind: "button",
          replyId: m.button.payload,
          replyTitle: m.button.text,
        };
      break;
    default:
      break;
  }
  return { ...base, kind: "unsupported", rawType: m.type };
}
