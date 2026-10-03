/** Payloads de webhook con la forma que documenta Meta. Se reutilizan en parse, ingest y webhook. */
export const PHONE_NUMBER_ID = "123456789012345";

function envelope(value: Record<string, unknown>, field = "messages") {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA_ID", changes: [{ field, value }] }],
  };
}

const metadata = { display_phone_number: "15551234567", phone_number_id: PHONE_NUMBER_ID };
const contact = { profile: { name: "Javier" }, wa_id: "584121234567" };

export const textMessage = (id = "wamid.TEXT1", body = "gasté 15$ en champú") =>
  envelope({
    messaging_product: "whatsapp",
    metadata,
    contacts: [contact],
    messages: [{ from: "584121234567", id, timestamp: "1759190400", type: "text", text: { body } }],
  });

export const audioMessage = envelope({
  messaging_product: "whatsapp",
  metadata,
  contacts: [contact],
  messages: [
    {
      from: "584121234567",
      id: "wamid.AUDIO1",
      timestamp: "1759190400",
      type: "audio",
      audio: { id: "MEDIA_AUDIO", mime_type: "audio/ogg; codecs=opus", sha256: "abc", voice: true },
    },
  ],
});

/** PDF (o cualquier archivo) mandado como documento; `mime_type` y `filename` se cambian por test. */
export const documentMessage = envelope({
  messaging_product: "whatsapp",
  metadata,
  contacts: [contact],
  messages: [
    {
      from: "584121234567",
      id: "wamid.DOC1",
      timestamp: "1759190400",
      type: "document",
      document: {
        id: "MEDIA_IMG",
        mime_type: "application/pdf",
        sha256: "ghi",
        filename: "factura-0042.pdf",
      },
    },
  ],
});

export const imageMessage = envelope({
  messaging_product: "whatsapp",
  metadata,
  contacts: [contact],
  messages: [
    {
      from: "584121234567",
      id: "wamid.IMG1",
      timestamp: "1759190400",
      type: "image",
      image: { id: "MEDIA_IMG", mime_type: "image/jpeg", sha256: "def", caption: "factura" },
    },
  ],
});

export const buttonReply = envelope({
  messaging_product: "whatsapp",
  metadata,
  contacts: [contact],
  messages: [
    {
      from: "584121234567",
      id: "wamid.BTN1",
      timestamp: "1759190400",
      type: "interactive",
      context: { from: "15551234567", id: "wamid.PROMPT1" },
      interactive: { type: "button_reply", button_reply: { id: "confirm:pa-1", title: "Guardar" } },
    },
  ],
});

export const listReply = envelope({
  messaging_product: "whatsapp",
  metadata,
  contacts: [contact],
  messages: [
    {
      from: "584121234567",
      id: "wamid.LIST1",
      timestamp: "1759190400",
      type: "interactive",
      interactive: {
        type: "list_reply",
        list_reply: { id: "cat:abc", title: "Insumos de lavado", description: "x" },
      },
    },
  ],
});

export const stickerMessage = envelope({
  messaging_product: "whatsapp",
  metadata,
  contacts: [contact],
  messages: [
    {
      from: "584121234567",
      id: "wamid.STK1",
      timestamp: "1759190400",
      type: "sticker",
      sticker: { id: "S" },
    },
  ],
});

/** Usuario con nombre de usuario: llega el BSUID y no el número. */
export const bsuidMessage = envelope({
  messaging_product: "whatsapp",
  metadata,
  contacts: [{ profile: { name: "María" }, wa_id: "BSUID_XYZ", user_id: "BSUID_XYZ" }],
  messages: [
    {
      from: "BSUID_XYZ",
      id: "wamid.BS1",
      timestamp: "1759190400",
      type: "text",
      text: { body: "hola" },
      user_id: "BSUID_XYZ",
    },
  ],
});

export const deliveredStatus = envelope({
  messaging_product: "whatsapp",
  metadata,
  statuses: [
    {
      id: "wamid.OUT1",
      status: "delivered",
      timestamp: "1759190401",
      recipient_id: "584121234567",
    },
  ],
});

export const failedStatus = envelope({
  messaging_product: "whatsapp",
  metadata,
  statuses: [
    {
      id: "wamid.OUT2",
      status: "failed",
      timestamp: "1759190401",
      recipient_id: "584121234567",
      errors: [
        {
          code: 131047,
          title: "Re-engagement message",
          error_data: { details: "ventana de 24 h cerrada" },
        },
      ],
    },
  ],
});

export const otherField = envelope({ some: "thing" }, "account_update");

/** Dos mensajes del mismo remitente en un solo webhook. */
export const twoMessages = envelope({
  messaging_product: "whatsapp",
  metadata,
  contacts: [contact],
  messages: [
    {
      from: "584121234567",
      id: "wamid.A",
      timestamp: "1759190400",
      type: "text",
      text: { body: "gasté 20$" },
    },
    {
      from: "584121234567",
      id: "wamid.B",
      timestamp: "1759190401",
      type: "text",
      text: { body: "en champú" },
    },
  ],
});
