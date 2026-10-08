import { and, desc, eq, gt, ne, schema, type Tx } from "@caja/db";
import { z } from "zod";
import type { IsoDate } from "../domain/dates";
import { Decimal } from "../domain/money";
import { type Bill, billTotal, computeSplit } from "../domain/split";
import { createExpenseDraft } from "../ledger/drafts";
import { NoRateError, rateFor } from "../ledger/rate-for";
import { es, type Outbound } from "../render/index";
import type { BillReader } from "../vision/bill";

/**
 * Dividir la cuenta por WhatsApp (06/10, pedido de Javier). Foto de la factura con la leyenda
 * "dividir" (o "cuánto paga cada quien"): se leen los renglones y, si la leyenda dice quién
 * consumió qué, sale cuánto paga cada uno; si no, la lista numerada y la pregunta. La respuesta
 * siguiente (30 minutos) reparte o corrige. Si quien escribe tiene parte, se ofrece guardarla
 * como gasto (un borrador normal: Guardar lo registra, No lo cancela).
 */
export const SPLIT_WORDS =
  /\b(divid\w*|reparti\w*|split)\b|cu[aá]nto\s+(paga|pone|le\s+toca)\s+cada|cada\s+qui[eé]n|por\s+persona/i;

/**
 * Después de un reparto, solo los mensajes que lo corrigen siguen siendo de la cuenta (08/10: el
 * bot repetía la división con "Registrar 12164 shawarma y refresco"). Antes del reparto (cuando
 * Rocco preguntó "¿quién consumió qué?") cualquier texto es la respuesta.
 */
export const SPLIT_CORRECTION =
  /^\s*no\b|\b(corrig\w*|correcci\w*|en realidad|mi parte|lo m[ií]o|lo suyo|lo de [a-zñáéíóú]+|el resto|lo dem[aá]s|cada uno|me toca|le toca|compart\w*|a medias|yo (com|tom|beb|consum|ped)\w*|(era|eran|fue|fueron) (el|la|los|las|mi|lo|de))\b/i;
const NOT_A_CORRECTION = /^\s*(registr|anot|gast[eé]|pagu[eé]|compr[eé]|vend[ií])\w*/i;

const BILL_SPLIT = "bill_split";
const SPLIT_WINDOW_MS = 30 * 60_000;

const BillJson = z.object({
  vendor: z.string(),
  currency: z.enum(["USD", "VES"]),
  items: z.array(z.object({ name: z.string(), quantity: z.number(), amount: z.string() })),
  total: z.string().nullable(),
});
const SplitMark = z.object({
  name: z.literal(BILL_SPLIT),
  args: z.object({ bill: BillJson, said: z.string(), pendingId: z.string().uuid().nullable() }),
});

const toJson = (b: Bill): z.infer<typeof BillJson> => ({
  vendor: b.vendor,
  currency: b.currency,
  items: b.items.map((i) => ({ name: i.name, quantity: i.quantity, amount: i.amount.toFixed(2) })),
  total: b.total ? b.total.toFixed(2) : null,
});
const fromJson = (j: z.infer<typeof BillJson>): Bill => ({
  vendor: j.vendor,
  currency: j.currency,
  items: j.items.map((i) => ({
    name: i.name,
    quantity: i.quantity,
    amount: new Decimal(i.amount),
  })),
  total: j.total ? new Decimal(j.total) : null,
});

type SplitCtx = { tenantId: string; phoneId: string; today: IsoDate };
type Usage = { inputTokens: number; outputTokens: number };
export type SplitOut = {
  outbound: Outbound[];
  toolCalls: { name: string; args: unknown }[];
  tokensIn: number;
  tokensOut: number;
  costUsd: string | null;
};

class Meter {
  tokensIn = 0;
  tokensOut = 0;
  cost = new Decimal(0);
  add(u: Usage, cost: string) {
    this.tokensIn += u.inputTokens;
    this.tokensOut += u.outputTokens;
    this.cost = this.cost.plus(cost);
  }
  out(outbound: Outbound[], toolCalls: SplitOut["toolCalls"]): SplitOut {
    return {
      outbound,
      toolCalls,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      costUsd: this.cost.toFixed(6),
    };
  }
}

/** Foto con leyenda de dividir: lee la cuenta y reparte si la leyenda ya lo dice. */
export async function splitFromPhoto(
  tx: Tx,
  bills: BillReader,
  ctx: SplitCtx,
  image: { bytes: Uint8Array; mimeType: string },
  caption: string,
  now: Date,
): Promise<SplitOut> {
  const meter = new Meter();
  const read = await bills.readBill(image.bytes, image.mimeType);
  meter.add(read.usage, read.costUsd);
  if (!read.bill || read.confidence < 0.5) return meter.out([es.splitUnreadable()], []);
  const out = await answer(tx, bills, ctx, read.bill, caption, null, now, "image", meter);
  return out ?? askWho(read.bill, meter);
}

/** Texto que responde a "¿quién consumió qué?" o corrige el reparto; null si no es eso. */
export async function splitFollowUp(
  tx: Tx,
  bills: BillReader,
  ctx: SplitCtx,
  text: string,
  now: Date,
): Promise<SplitOut | null> {
  const prev = await splitBefore(tx, ctx.phoneId, now);
  if (!prev) return null;
  if (prev.said && !isCorrection(text)) return null;
  const meter = new Meter();
  const said = prev.said ? `${prev.said}\n${text}` : text;
  return answer(tx, bills, ctx, prev.bill, said, prev.pendingId, now, "text", meter);
}

function isCorrection(text: string): boolean {
  if (NOT_A_CORRECTION.test(text) && !SPLIT_WORDS.test(text)) return false;
  return SPLIT_WORDS.test(text) || SPLIT_CORRECTION.test(text);
}

function askWho(bill: Bill, meter: Meter): SplitOut {
  return meter.out(
    [es.splitAskWho({ ...bill, total: billTotal(bill) })],
    [{ name: BILL_SPLIT, args: { bill: toJson(bill), said: "", pendingId: null } }],
  );
}

async function answer(
  tx: Tx,
  bills: BillReader,
  ctx: SplitCtx,
  bill: Bill,
  said: string,
  prevPending: string | null,
  now: Date,
  channel: "image" | "text",
  meter: Meter,
): Promise<SplitOut | null> {
  const a = await bills.assign(bill, said);
  meter.add(a.usage, a.costUsd);
  const result = a.assignment ? computeSplit(bill, a.assignment) : null;
  if (!result) return null;
  const myShare =
    result.mode === "equal" ? result.each : (result.people.find((p) => p.isMe)?.total ?? null);
  let saveId: string | null = null;
  if (myShare?.gt(0)) {
    const draft = await createExpenseDraft(
      tx,
      {
        tenantId: ctx.tenantId,
        phoneId: ctx.phoneId,
        amount: myShare,
        currency: bill.currency,
        currencyInferred: false,
        ...(await mealCategory(tx, ctx.tenantId)),
        description: bill.vendor ? `Mi parte · ${bill.vendor}` : "Mi parte de la cuenta",
        businessDate: ctx.today,
        sourceChannel: channel,
        sourceMessageId: null,
        attachmentId: null,
        transcript: null,
        replaces: prevPending,
      },
      now,
    ).catch((err) => {
      if (err instanceof NoRateError) return null;
      throw err;
    });
    saveId = draft?.pendingId ?? null;
  }
  let usdRate: Decimal | null = null;
  if (bill.currency === "VES")
    usdRate = await rateFor(tx, ctx.today)
      .then((r) => r.rate.value)
      .catch(() => null);
  return meter.out(
    [
      es.splitResult({
        vendor: bill.vendor,
        currency: bill.currency,
        usdRate,
        result,
        saveId,
        myShare,
      }),
    ],
    [{ name: BILL_SPLIT, args: { bill: toJson(bill), said, pendingId: saveId } }],
  );
}

/** Categoría para "mi parte": comida fuera, restaurante o salidas; si no hay, sin categoría. */
async function mealCategory(
  tx: Tx,
  tenantId: string,
): Promise<{ categoryId: string | null; categoryName: string | null }> {
  const c = schema.category;
  const all = await tx
    .select({ id: c.id, name: c.name })
    .from(c)
    .where(and(eq(c.tenantId, tenantId), eq(c.kind, "expense"), eq(c.isActive, true)));
  const plain = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const hit =
    all.find((x) => /comida fuera|restaurant/.test(plain(x.name))) ??
    all.find((x) => /comida|salidas|entreten/.test(plain(x.name))) ??
    all.find((x) => plain(x.name) === "otros");
  return { categoryId: hit?.id ?? null, categoryName: hit?.name ?? null };
}

/** Lo último que respondió el bot (30 min) fue una cuenta para dividir: la cuenta y lo dicho. */
async function splitBefore(
  tx: Tx,
  phoneId: string,
  now: Date,
): Promise<{ bill: Bill; said: string; pendingId: string | null } | null> {
  const [last] = await tx
    .select({ toolCalls: schema.message.toolCalls })
    .from(schema.message)
    .where(
      and(
        eq(schema.message.phoneId, phoneId),
        eq(schema.message.direction, "out"),
        ne(schema.message.kind, "reaction"),
        gt(schema.message.createdAt, new Date(now.getTime() - SPLIT_WINDOW_MS)),
      ),
    )
    .orderBy(desc(schema.message.createdAt))
    .limit(1);
  const calls: unknown[] = Array.isArray(last?.toolCalls) ? last.toolCalls : [];
  const mark = SplitMark.safeParse(
    calls.find((c) => (c as { name?: string } | null)?.name === BILL_SPLIT),
  );
  if (!mark.success) return null;
  // Ya tocó "Guardar mi parte" o "No, gracias" (o venció): la cuenta quedó cerrada.
  if (mark.data.args.pendingId) {
    const [p] = await tx
      .select({ status: schema.pendingAction.status })
      .from(schema.pendingAction)
      .where(eq(schema.pendingAction.id, mark.data.args.pendingId));
    if (p?.status !== "pending") return null;
  }
  return {
    bill: fromJson(mark.data.args.bill),
    said: mark.data.args.said,
    pendingId: mark.data.args.pendingId,
  };
}
