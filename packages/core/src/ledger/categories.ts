import { and, eq, rows, schema, sql, type Tx } from "@caja/db";

/**
 * Categorías de gasto (US-E5) y configuración del negocio (US-E7) desde el dashboard. Las
 * categorías se desactivan, nunca se borran: los movimientos las siguen apuntando. Todo cambio
 * deja auditoría con actor `user` y canal `dashboard`.
 */
export type CategoryRow = {
  id: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
  movements: number;
};

export class CategoryError extends Error {
  constructor(public readonly code: "duplicate" | "missing" | "invalid") {
    super(code);
    this.name = "CategoryError";
  }
}

const normalize = (name: string) => name.trim().replace(/\s+/g, " ");

/**
 * Fuentes de ingreso de una cuenta personal (19/10): lo que entra no son ventas sino sueldo,
 * trabajos por cuenta propia, remesas… Se crean solas la primera vez (`ensureIncomeCategories`) y
 * el usuario las cambia en Ajustes → Categorías.
 */
export const PERSONAL_INCOME_CATEGORIES = [
  "Salario",
  "Freelance",
  "Negocio propio",
  "Remesas",
  "Bonos y extras",
  "Alquileres",
  "Otros ingresos",
] as const;
export const OTHER_INCOME = "Otros ingresos";

export type CategoryKind = "expense" | "income";

export async function listCategories(
  tx: Tx,
  tenantId: string,
  kind: CategoryKind = "expense",
): Promise<CategoryRow[]> {
  const c = schema.category;
  const list = await tx
    .select({
      id: c.id,
      name: c.name,
      isActive: c.isActive,
      sortOrder: c.sortOrder,
      // La columna va calificada con la tabla: ${c.id} solo se escribe "id" y dentro de la
      // subconsulta se resolvería como m.id (siempre 0).
      movements: sql<number>`(select count(*)::int from ${schema.movement} m where m.category_id = ${c}.id and m.deleted_at is null)`,
    })
    .from(c)
    .where(and(eq(c.tenantId, tenantId), eq(c.kind, kind)))
    .orderBy(c.sortOrder, c.name);
  return list.map((r) => ({ ...r, movements: Number(r.movements) }));
}

async function nameTaken(
  tx: Tx,
  tenantId: string,
  name: string,
  kind: CategoryKind,
  exceptId?: string,
) {
  const c = schema.category;
  const rows = await tx
    .select({ id: c.id })
    .from(c)
    .where(and(eq(c.tenantId, tenantId), eq(c.kind, kind), sql`lower(${c.name}) = lower(${name})`));
  return rows.some((r) => r.id !== exceptId);
}

export async function createCategory(
  tx: Tx,
  ref: { tenantId: string; userId: string },
  rawName: string,
  kind: CategoryKind = "expense",
): Promise<string> {
  const name = normalize(rawName);
  if (name.length < 2 || name.length > 40) throw new CategoryError("invalid");
  if (await nameTaken(tx, ref.tenantId, name, kind)) throw new CategoryError("duplicate");
  const [max] = await tx
    .select({ n: sql<number>`coalesce(max(${schema.category.sortOrder}), -1)` })
    .from(schema.category)
    .where(eq(schema.category.tenantId, ref.tenantId));
  const [row] = await tx
    .insert(schema.category)
    .values({ tenantId: ref.tenantId, name, kind, sortOrder: Number(max?.n ?? -1) + 1 })
    .returning({ id: schema.category.id });
  if (!row) throw new Error("no se pudo crear la categoría");
  await audit(tx, ref, "create", "category", row.id, null, { name, kind });
  return row.id;
}

export async function renameCategory(
  tx: Tx,
  ref: { tenantId: string; userId: string },
  id: string,
  rawName: string,
): Promise<void> {
  const name = normalize(rawName);
  if (name.length < 2 || name.length > 40) throw new CategoryError("invalid");
  const [before] = await tx
    .select()
    .from(schema.category)
    .where(and(eq(schema.category.tenantId, ref.tenantId), eq(schema.category.id, id)));
  if (!before) throw new CategoryError("missing");
  if (before.name === name) return;
  if (await nameTaken(tx, ref.tenantId, name, before.kind === "income" ? "income" : "expense", id))
    throw new CategoryError("duplicate");
  await tx.update(schema.category).set({ name }).where(eq(schema.category.id, id));
  await audit(tx, ref, "update", "category", id, { name: before.name }, { name });
}

export async function setCategoryActive(
  tx: Tx,
  ref: { tenantId: string; userId: string },
  id: string,
  isActive: boolean,
): Promise<void> {
  const [before] = await tx
    .select()
    .from(schema.category)
    .where(and(eq(schema.category.tenantId, ref.tenantId), eq(schema.category.id, id)));
  if (!before) throw new CategoryError("missing");
  if (before.isActive === isActive) return;
  await tx.update(schema.category).set({ isActive }).where(eq(schema.category.id, id));
  await audit(tx, ref, "update", "category", id, { isActive: before.isActive }, { isActive });
}

export type TenantSettings = {
  name: string;
  businessType: (typeof schema.BUSINESS_TYPES)[number];
  defaultExpenseCurrency: "USD" | "VES";
  /** De dónde sale la tasa de los gastos en Bs (0012). */
  bsRateMode: "bcv" | "usdt" | "ask";
};

export async function getTenantSettings(tx: Tx, tenantId: string): Promise<TenantSettings | null> {
  const [t] = await tx
    .select({
      name: schema.tenant.name,
      businessType: schema.tenant.businessType,
      defaultExpenseCurrency: schema.tenant.defaultExpenseCurrency,
      bsRateMode: schema.tenant.bsRateMode,
    })
    .from(schema.tenant)
    .where(eq(schema.tenant.id, tenantId));
  if (!t) return null;
  return {
    name: t.name,
    businessType: t.businessType as TenantSettings["businessType"],
    defaultExpenseCurrency: (t.defaultExpenseCurrency as "USD" | "VES" | null) ?? "USD",
    bsRateMode: (t.bsRateMode as TenantSettings["bsRateMode"] | null) ?? "bcv",
  };
}

/** Nombre, tipo y moneda por defecto (US-E7). El tipo no vuelve a crear categorías: solo etiqueta. */
export async function updateTenantSettings(
  tx: Tx,
  ref: { tenantId: string; userId: string },
  input: Omit<TenantSettings, "bsRateMode"> & { bsRateMode?: TenantSettings["bsRateMode"] },
): Promise<void> {
  const name = normalize(input.name);
  if (name.length < 2 || name.length > 80) throw new CategoryError("invalid");
  const before = await getTenantSettings(tx, ref.tenantId);
  if (!before) throw new CategoryError("missing");
  const after: TenantSettings = {
    ...input,
    name,
    bsRateMode: input.bsRateMode ?? before.bsRateMode,
  };
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  await tx
    .update(schema.tenant)
    .set({
      name,
      businessType: input.businessType,
      defaultExpenseCurrency: input.defaultExpenseCurrency,
      bsRateMode: after.bsRateMode,
      updatedAt: new Date(),
    })
    .where(eq(schema.tenant.id, ref.tenantId));
  await audit(tx, ref, "update", "tenant", ref.tenantId, before, after);
}

async function audit(
  tx: Tx,
  ref: { tenantId: string; userId: string },
  action: "create" | "update",
  entity: "category" | "tenant",
  entityId: string,
  before: unknown,
  after: unknown,
) {
  await tx.insert(schema.auditLog).values({
    tenantId: ref.tenantId,
    actorType: "user",
    actorId: ref.userId,
    action,
    entity,
    entityId,
    before,
    after,
    channel: "dashboard",
  });
}

/**
 * "Otros" como red de seguridad (16/10): el gasto que no encaja en ninguna categoría va ahí, nunca
 * a la primera de la lista. Si el negocio no la tiene, se crea; si la desactivó, se reactiva. Lo
 * hace el sistema, con su auditoría.
 */
export async function ensureOtherCategory(tx: Tx, tenantId: string): Promise<void> {
  const c = schema.category;
  const [row] = await tx
    .select({ id: c.id, isActive: c.isActive })
    .from(c)
    .where(and(eq(c.tenantId, tenantId), eq(c.kind, "expense"), sql`lower(${c.name}) = 'otros'`));
  if (row?.isActive) return;
  const entry = (entityId: string, before: unknown, after: unknown, action: "create" | "update") =>
    tx.insert(schema.auditLog).values({
      tenantId,
      actorType: "system",
      actorId: null,
      action,
      entity: "category",
      entityId,
      before,
      after,
      channel: "whatsapp",
    });
  if (row) {
    await tx.update(c).set({ isActive: true }).where(eq(c.id, row.id));
    await entry(row.id, { isActive: false }, { isActive: true }, "update");
    return;
  }
  const [max] = await tx
    .select({ n: sql<number>`coalesce(max(${c.sortOrder}), -1)` })
    .from(c)
    .where(eq(c.tenantId, tenantId));
  const [created] = await tx
    .insert(c)
    .values({ tenantId, name: "Otros", kind: "expense", sortOrder: Number(max?.n ?? -1) + 1 })
    .returning({ id: c.id });
  if (created) await entry(created.id, null, { name: "Otros" }, "create");
}

/**
 * Las fuentes de ingreso de una cuenta personal: si no tiene ninguna (ni activa ni apagada), se
 * crean las de `PERSONAL_INCOME_CATEGORIES`; si apagó "Otros ingresos", se reactiva (es la red
 * cuando la IA no sabe de dónde vino). Lo hace el sistema, con su auditoría.
 */
export async function ensureIncomeCategories(
  tx: Tx,
  tenantId: string,
  channel: "whatsapp" | "dashboard" = "whatsapp",
): Promise<void> {
  const c = schema.category;
  const existing = await tx
    .select({ id: c.id, name: c.name, isActive: c.isActive })
    .from(c)
    .where(and(eq(c.tenantId, tenantId), eq(c.kind, "income")));
  const entry = (entityId: string, before: unknown, after: unknown, action: "create" | "update") =>
    tx.insert(schema.auditLog).values({
      tenantId,
      actorType: "system",
      actorId: null,
      action,
      entity: "category",
      entityId,
      before,
      after,
      channel,
    });
  const other = existing.find((r) => r.name.toLowerCase() === OTHER_INCOME.toLowerCase());
  if (other && !other.isActive) {
    await tx.update(c).set({ isActive: true }).where(eq(c.id, other.id));
    await entry(other.id, { isActive: false }, { isActive: true }, "update");
  }
  const missing = existing.length ? (other ? [] : [OTHER_INCOME]) : [...PERSONAL_INCOME_CATEGORIES];
  if (!missing.length) return;
  const [max] = await tx
    .select({ n: sql<number>`coalesce(max(${c.sortOrder}), -1)` })
    .from(c)
    .where(eq(c.tenantId, tenantId));
  let order = Number(max?.n ?? -1);
  const created = await tx
    .insert(c)
    .values(missing.map((name) => ({ tenantId, name, kind: "income", sortOrder: ++order })))
    .returning({ id: c.id, name: c.name });
  for (const r of created) await entry(r.id, null, { name: r.name, kind: "income" }, "create");
}

export type CategoryExample = { description: string; category: string };

/**
 * Cómo categoriza este negocio (16/10): sus gastos recientes, una vez por descripción, con la
 * categoría en que quedaron (ya corregida: Corregir reemplaza el gasto y el dashboard lo edita).
 * La IA los usa para gastos parecidos. "Otros" no se enseña: es el comodín.
 */
export async function categoryExamples(
  tx: Tx,
  tenantId: string,
  limit = 40,
): Promise<CategoryExample[]> {
  const m = schema.movement;
  const c = schema.category;
  const result = await tx.execute(sql`
    select description, category from (
      select distinct on (lower(trim(${m.description})))
        trim(${m.description}) as description, ${c.name} as category, ${m.createdAt} as at
      from ${m} join ${c} on ${c.id} = ${m.categoryId}
      where ${m.tenantId} = ${tenantId} and ${m.type} = 'expense' and ${m.deletedAt} is null
        and ${m.description} is not null and trim(${m.description}) <> ''
        and ${c.isActive} and lower(${c.name}) <> 'otros'
      order by lower(trim(${m.description})), ${m.createdAt} desc
    ) x order by at desc limit ${limit}`);
  return rows<CategoryExample>(result).map((r) => ({
    description: r.description,
    category: r.category,
  }));
}
