import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Esquema Drizzle del schema `app`. La fuente de verdad para la base es
 * `packages/db/migrations/*.sql`; este archivo debe reflejarla para que las
 * consultas queden tipadas. `drizzle-kit check` detecta divergencias.
 */
export const app = pgSchema("app");

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
};

export const BUSINESS_TYPES = ["car_wash", "food", "retail", "services", "other"] as const;
export const CURRENCIES = ["USD", "VES"] as const;
export const PHONE_ROLES = ["owner", "employee"] as const;
export const PHONE_STATUSES = ["pending", "active", "disabled"] as const;
export const TENANT_STATUSES = ["trial", "active", "suspended"] as const;
export const PLAN_IDS = ["personal", "negocio", "negocio_plus"] as const;
export const PAYMENT_METHODS_BILLING = ["pago_movil", "zelle", "binance"] as const;
export const PAYMENT_CURRENCIES = ["VES", "USD", "USDT"] as const;
export const PAYMENT_STATUSES = ["pending", "approved", "rejected"] as const;
export const BILLING_RATE_KINDS = ["bcv_usd", "bcv_eur", "manual"] as const;
export const MOVEMENT_TYPES = ["expense", "income"] as const;
export const BUDGET_PERIODS = ["monthly", "biweekly"] as const;
export const MOVEMENT_ORIGINS = ["single", "day_total"] as const;
export const RATE_SOURCES = ["bcv", "bcv_eur", "manual", "exchange"] as const;
export const BS_RATE_MODES = ["bcv", "usdt", "ask"] as const;
export const ACCOUNT_KINDS = ["bank", "cash", "zelle", "crypto", "other"] as const;
export const LOT_SOURCES = ["exchange", "income", "opening", "transfer"] as const;
export const SOURCE_CHANNELS = ["text", "voice", "image", "dashboard"] as const;
export const PAYMENT_METHODS = [
  "cash_usd",
  "cash_ves",
  "pago_movil",
  "punto",
  "zelle",
  "transfer_usd",
  "transfer_ves",
  "other",
  "unspecified",
] as const;
export const PENDING_KINDS = [
  "create_expense",
  "create_expenses",
  "create_income_day_total",
  "create_income_single",
  "replace_day_total",
  "edit_last",
  "delete_last",
  "renew_plan",
  "create_exchange",
  "create_transfer",
] as const;
export const PENDING_STATUSES = ["pending", "confirmed", "cancelled", "expired"] as const;

const inList = (col: string, values: readonly string[]) =>
  sql.raw(`${col} IN (${values.map((v) => `'${v}'`).join(", ")})`);

export const tenant = app.table(
  "tenant",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    name: text("name").notNull(),
    businessType: text("business_type").notNull(),
    defaultExpenseCurrency: text("default_expense_currency"),
    vesThreshold: numeric("ves_threshold", { precision: 18, scale: 2 }).notNull().default("1000"),
    timezone: text("timezone").notNull().default("America/Caracas"),
    waPhoneNumberId: text("wa_phone_number_id"),
    closeReminderTime: time("close_reminder_time").notNull().default("18:00"),
    status: text("status").notNull().default("trial"),
    plan: text("plan").notNull().default("negocio"),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }).default(
      sql`now() + interval '14 days'`,
    ),
    paidUntil: timestamp("paid_until", { withTimezone: true }),
    capNotifiedMonth: text("cap_notified_month"),
    /** De dónde sale la tasa de los gastos en Bs (0012): BCV, los lotes de cambio, o preguntar. */
    bsRateMode: text("bs_rate_mode").notNull().default("bcv"),
    ...timestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check("tenant_plan_check", inList("plan", PLAN_IDS)),
    check("tenant_business_type_check", inList("business_type", BUSINESS_TYPES)),
    check(
      "tenant_default_expense_currency_check",
      sql.raw(`default_expense_currency IS NULL OR default_expense_currency IN ('USD', 'VES')`),
    ),
    check("tenant_status_check", inList("status", TENANT_STATUSES)),
    check("tenant_bs_rate_mode_check", inList("bs_rate_mode", BS_RATE_MODES)),
  ],
);

export const userAccount = app.table("user_account", {
  // Coincide con auth.users.id de Supabase Auth.
  id: uuid("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name"),
  ...timestamps,
});

export const tenantMember = app.table(
  "tenant_member",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => userAccount.id),
    role: text("role").notNull().default("owner"),
    ...timestamps,
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId] }),
    check("tenant_member_role_check", sql.raw(`role IN ('owner')`)),
  ],
);

export const phoneNumber = app.table(
  "phone_number",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    e164: text("e164").notNull().unique(),
    waUserId: text("wa_user_id").unique(),
    role: text("role").notNull(),
    status: text("status").notNull().default("pending"),
    displayName: text("display_name"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("phone_number_tenant_idx").on(t.tenantId),
    check("phone_number_role_check", inList("role", PHONE_ROLES)),
    check("phone_number_status_check", inList("status", PHONE_STATUSES)),
  ],
);

export const phoneVerification = app.table("phone_verification", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenant.id),
  phoneId: uuid("phone_id")
    .notNull()
    .references(() => phoneNumber.id),
  codeHash: text("code_hash").notNull(),
  attempts: integer("attempts").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  ...timestamps,
});

export const category = app.table(
  "category",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("expense"),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("category_tenant_kind_name_key").on(t.tenantId, t.kind, t.name),
    check("category_kind_check", sql.raw(`kind IN ('expense', 'income')`)),
  ],
);

export const bcvRate = app.table("bcv_rate", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  effectiveDate: date("effective_date").notNull().unique(),
  rate: numeric("rate", { precision: 18, scale: 8 }).notNull(),
  /** Euro oficial del BCV, misma fecha valor (0007). Null en filas viejas o si la fuente no lo dio. */
  rateEur: numeric("rate_eur", { precision: 18, scale: 8 }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  source: text("source").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

export const attachment = app.table("attachment", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenant.id),
  kind: text("kind").notNull(),
  storageKey: text("storage_key").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: text("sha256"),
  ...timestamps,
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const webhookEvent = app.table("webhook_event", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  eventKey: text("event_key").notNull().unique(),
  payload: jsonb("payload").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  status: text("status").notNull().default("received"),
  error: text("error"),
});

export const message = app.table(
  "message",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    phoneId: uuid("phone_id")
      .notNull()
      .references(() => phoneNumber.id),
    direction: text("direction").notNull(),
    waMessageId: text("wa_message_id").unique(),
    kind: text("kind").notNull(),
    body: text("body"),
    mediaId: text("media_id"),
    toolCalls: jsonb("tool_calls"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    latencyMs: integer("latency_ms"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
    status: text("status").notNull().default("ok"),
    webhookEventId: uuid("webhook_event_id").references(() => webhookEvent.id),
    ...timestamps,
  },
  (t) => [
    index("message_phone_recent_idx").on(t.phoneId, t.createdAt),
    check("message_direction_check", sql.raw(`direction IN ('in', 'out')`)),
  ],
);

export const movement = app.table(
  "movement",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    type: text("type").notNull(),
    businessDate: date("business_date").notNull(),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    currency: text("currency").notNull(),
    rateId: uuid("rate_id").references(() => bcvRate.id),
    rateValue: numeric("rate_value", { precision: 18, scale: 8 }).notNull(),
    rateSource: text("rate_source").notNull().default("bcv"),
    amountUsd: numeric("amount_usd", { precision: 14, scale: 2 }).notNull(),
    amountVes: numeric("amount_ves", { precision: 18, scale: 2 }).notNull(),
    categoryId: uuid("category_id").references(() => category.id),
    paymentMethod: text("payment_method").notNull().default("unspecified"),
    description: text("description"),
    origin: text("origin").notNull().default("single"),
    sourceChannel: text("source_channel").notNull(),
    createdByPhoneId: uuid("created_by_phone_id").references(() => phoneNumber.id),
    createdByUserId: uuid("created_by_user_id").references(() => userAccount.id),
    sourceMessageId: uuid("source_message_id").references(() => message.id),
    attachmentId: uuid("attachment_id").references(() => attachment.id),
    /** Cuenta de donde salió o a donde entró (0013); null si el negocio no usa cuentas. */
    accountId: uuid("account_id").references((): AnyPgColumn => account.id),
    ...timestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("movement_account_idx")
      .on(t.accountId)
      .where(sql`deleted_at IS NULL AND account_id IS NOT NULL`),
    index("movement_tenant_date_idx").on(t.tenantId, t.businessDate).where(sql`deleted_at IS NULL`),
    index("movement_tenant_category_idx")
      .on(t.tenantId, t.categoryId)
      .where(sql`deleted_at IS NULL`),
    check("movement_type_check", inList("type", MOVEMENT_TYPES)),
    check("movement_rate_source_check", inList("rate_source", RATE_SOURCES)),
    check(
      "movement_rate_source_id",
      sql.raw(`rate_source IN ('manual', 'exchange') OR rate_id IS NOT NULL`),
    ),
    check("movement_currency_check", inList("currency", CURRENCIES)),
    check("movement_amount_positive", sql.raw(`amount > 0`)),
    check("movement_payment_method_check", inList("payment_method", PAYMENT_METHODS)),
    check("movement_origin_check", inList("origin", MOVEMENT_ORIGINS)),
    check("movement_source_channel_check", inList("source_channel", SOURCE_CHANNELS)),
    check(
      "movement_single_author",
      sql.raw(`(created_by_phone_id IS NULL) <> (created_by_user_id IS NULL)`),
    ),
    // movement_income_needs_method se quitó en 0010: un ingreso suelto puede no decir el método.
  ],
);

export const pendingAction = app.table(
  "pending_action",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    phoneId: uuid("phone_id")
      .notNull()
      .references(() => phoneNumber.id),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("pending"),
    promptMessageId: uuid("prompt_message_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // Cola de borradores (0006): varios pendientes por teléfono, sin índice único.
    index("pending_action_phone_pending").on(t.phoneId, t.createdAt).where(sql`status = 'pending'`),
    check("pending_action_kind_check", inList("kind", PENDING_KINDS)),
    check("pending_action_status_check", inList("status", PENDING_STATUSES)),
  ],
);

export const auditLog = app.table(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    actorType: text("actor_type").notNull(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: uuid("entity_id").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    channel: text("channel").notNull(),
    ...timestamps,
  },
  (t) => [
    index("audit_tenant_entity_idx").on(t.tenantId, t.entity, t.entityId),
    check("audit_log_actor_type_check", sql.raw(`actor_type IN ('phone', 'user', 'system')`)),
  ],
);

export const integration = app.table("integration", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenant.id),
  provider: text("provider").notNull(),
  configEncrypted: text("config_encrypted"),
  status: text("status").notNull().default("disabled"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  ...timestamps,
});

/** Conteo de mensajes de números desconocidos para rate limit. Sin contenido, sin tenant. */
export const unknownSenderHit = app.table("unknown_sender_hit", {
  e164: text("e164").primaryKey(),
  hits: integer("hits").notNull().default(0),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
});

export type Tenant = typeof tenant.$inferSelect;
export type PhoneNumber = typeof phoneNumber.$inferSelect;
export type Category = typeof category.$inferSelect;
export type BcvRate = typeof bcvRate.$inferSelect;
export type Movement = typeof movement.$inferSelect;
export type NewMovement = typeof movement.$inferInsert;
export type PendingAction = typeof pendingAction.$inferSelect;
export type Message = typeof message.$inferSelect;
export type WebhookEvent = typeof webhookEvent.$inferSelect;

export const payment = app.table(
  "payment",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    plan: text("plan").notNull(),
    months: integer("months").notNull().default(1),
    method: text("method").notNull(),
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    currency: text("currency").notNull(),
    rateKind: text("rate_kind"),
    rateValue: numeric("rate_value", { precision: 18, scale: 8 }),
    amountUsd: numeric("amount_usd", { precision: 18, scale: 2 }).notNull(),
    reference: text("reference"),
    status: text("status").notNull().default("pending"),
    notes: text("notes"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    /** Aviso por WhatsApp de "pago verificado" o "no verificado" (0011). */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("payment_tenant_idx").on(t.tenantId, t.createdAt),
    check("payment_plan_check", inList("plan", PLAN_IDS)),
    check("payment_method_check", inList("method", PAYMENT_METHODS_BILLING)),
    check("payment_currency_check", inList("currency", PAYMENT_CURRENCIES)),
    check("payment_status_check", inList("status", PAYMENT_STATUSES)),
  ],
);

/** Tope de gasto por categoría (0009): mensual o quincenal, en dólares. Uno por categoría. */
export const budget = app.table(
  "budget",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => category.id),
    period: text("period").notNull(),
    amountUsd: numeric("amount_usd", { precision: 18, scale: 2 }).notNull(),
    ...timestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("budget_tenant_category_key").on(t.tenantId, t.categoryId),
    check("budget_period_check", inList("period", BUDGET_PERIODS)),
  ],
);

/** Cuenta donde vive el dinero (0013): banco en Bs, Binance, Zelle, efectivo. */
export const account = app.table(
  "account",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    name: text("name").notNull(),
    currency: text("currency").notNull(),
    kind: text("kind").notNull().default("bank"),
    openingBalance: numeric("opening_balance", { precision: 18, scale: 2 }).notNull().default("0"),
    openingDate: date("opening_date").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    createdByPhoneId: uuid("created_by_phone_id").references(() => phoneNumber.id),
    createdByUserId: uuid("created_by_user_id").references(() => userAccount.id),
    ...timestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("account_tenant_name_key")
      .on(t.tenantId, sql`lower(${t.name})`)
      .where(sql`archived_at IS NULL`),
    check("account_currency_check", inList("currency", CURRENCIES)),
    check("account_kind_check", inList("kind", ACCOUNT_KINDS)),
    check("account_name_check", sql.raw(`char_length(btrim(name)) BETWEEN 1 AND 40`)),
  ],
);

/** Cambio de USDT a bolívares (0012): los gastos en Bs salen de aquí en orden (FIFO). */
export const exchangeLot = app.table(
  "exchange_lot",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    businessDate: date("business_date").notNull(),
    usdAmount: numeric("usd_amount", { precision: 14, scale: 2 }).notNull(),
    vesAmount: numeric("ves_amount", { precision: 18, scale: 2 }).notNull(),
    rate: numeric("rate", { precision: 18, scale: 8 }).notNull(),
    vesRemaining: numeric("ves_remaining", { precision: 18, scale: 2 }).notNull(),
    /** Cuenta en Bs del lote (0013); null = lote de antes de las cuentas. */
    accountId: uuid("account_id").references(() => account.id),
    /** Cuenta en dólares de donde salieron los USDT de un cambio. */
    fromAccountId: uuid("from_account_id").references(() => account.id),
    source: text("source").notNull().default("exchange"),
    /** La venta en Bs que dio origen al lote (source = income). */
    movementId: uuid("movement_id").references(() => movement.id),
    /** Lote de antes de las cuentas que adoptó una cuenta: ya está en su saldo inicial. */
    adoptedAt: timestamp("adopted_at", { withTimezone: true }),
    /** La transferencia en Bs que dejó este lote en la cuenta de destino (0014). */
    transferId: uuid("transfer_id").references((): AnyPgColumn => accountTransfer.id),
    createdByPhoneId: uuid("created_by_phone_id").references(() => phoneNumber.id),
    createdByUserId: uuid("created_by_user_id").references(() => userAccount.id),
    ...timestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("exchange_lot_movement_key")
      .on(t.movementId)
      .where(sql`movement_id IS NOT NULL AND deleted_at IS NULL`),
    uniqueIndex("exchange_lot_opening_key")
      .on(t.accountId)
      .where(sql`source = 'opening' AND deleted_at IS NULL`),
    index("exchange_lot_account_fifo_idx")
      .on(t.accountId, t.businessDate, t.createdAt)
      .where(sql`deleted_at IS NULL`),
    check("exchange_lot_source_check", inList("source", LOT_SOURCES)),
    index("exchange_lot_tenant_fifo_idx")
      .on(t.tenantId, t.businessDate, t.createdAt)
      .where(sql`deleted_at IS NULL`),
    check("exchange_lot_amounts_check", sql.raw(`usd_amount > 0 AND ves_amount > 0 AND rate > 0`)),
    check(
      "exchange_lot_remaining_check",
      sql.raw(`ves_remaining >= 0 AND ves_remaining <= ves_amount`),
    ),
  ],
);

/** De qué lote salió cada gasto en Bs (0012), para devolver el saldo al borrar o corregir. */
export const exchangeAllocation = app.table(
  "exchange_allocation",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    /** De un gasto o (0014) de una transferencia: uno de los dos. */
    movementId: uuid("movement_id").references(() => movement.id),
    transferId: uuid("transfer_id").references((): AnyPgColumn => accountTransfer.id),
    lotId: uuid("lot_id")
      .notNull()
      .references(() => exchangeLot.id),
    vesAmount: numeric("ves_amount", { precision: 18, scale: 2 }).notNull(),
    ...timestamps,
  },
  (t) => [
    index("exchange_allocation_movement_idx").on(t.movementId),
    index("exchange_allocation_lot_idx").on(t.lotId),
    index("exchange_allocation_transfer_idx").on(t.transferId).where(sql`transfer_id IS NOT NULL`),
    check("exchange_allocation_amount_check", sql.raw(`ves_amount > 0`)),
    check(
      "exchange_allocation_owner_check",
      sql.raw(`(movement_id IS NULL) <> (transfer_id IS NULL)`),
    ),
  ],
);

/** Transferencia entre cuentas (0014): mueve dinero sin ser gasto ni venta. */
export const accountTransfer = app.table(
  "account_transfer",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id),
    fromAccountId: uuid("from_account_id")
      .notNull()
      .references(() => account.id),
    toAccountId: uuid("to_account_id")
      .notNull()
      .references(() => account.id),
    fromAmount: numeric("from_amount", { precision: 18, scale: 2 }).notNull(),
    toAmount: numeric("to_amount", { precision: 18, scale: 2 }).notNull(),
    businessDate: date("business_date").notNull(),
    description: text("description"),
    /** La comisión, como gasto de la cuenta de origen. */
    feeMovementId: uuid("fee_movement_id").references(() => movement.id),
    createdByPhoneId: uuid("created_by_phone_id").references(() => phoneNumber.id),
    createdByUserId: uuid("created_by_user_id").references(() => userAccount.id),
    ...timestamps,
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("account_transfer_from_idx").on(t.fromAccountId).where(sql`deleted_at IS NULL`),
    index("account_transfer_to_idx").on(t.toAccountId).where(sql`deleted_at IS NULL`),
    check("account_transfer_amounts_check", sql.raw(`from_amount > 0 AND to_amount > 0`)),
    check("account_transfer_accounts_check", sql.raw(`from_account_id <> to_account_id`)),
  ],
);
