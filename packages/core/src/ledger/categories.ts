import { and, eq, schema, sql, type Tx } from "@caja/db";

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

export async function listCategories(tx: Tx, tenantId: string): Promise<CategoryRow[]> {
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
    .where(and(eq(c.tenantId, tenantId), eq(c.kind, "expense")))
    .orderBy(c.sortOrder, c.name);
  return list.map((r) => ({ ...r, movements: Number(r.movements) }));
}

async function nameTaken(tx: Tx, tenantId: string, name: string, exceptId?: string) {
  const c = schema.category;
  const rows = await tx
    .select({ id: c.id })
    .from(c)
    .where(
      and(eq(c.tenantId, tenantId), eq(c.kind, "expense"), sql`lower(${c.name}) = lower(${name})`),
    );
  return rows.some((r) => r.id !== exceptId);
}

export async function createCategory(
  tx: Tx,
  ref: { tenantId: string; userId: string },
  rawName: string,
): Promise<string> {
  const name = normalize(rawName);
  if (name.length < 2 || name.length > 40) throw new CategoryError("invalid");
  if (await nameTaken(tx, ref.tenantId, name)) throw new CategoryError("duplicate");
  const [max] = await tx
    .select({ n: sql<number>`coalesce(max(${schema.category.sortOrder}), -1)` })
    .from(schema.category)
    .where(eq(schema.category.tenantId, ref.tenantId));
  const [row] = await tx
    .insert(schema.category)
    .values({ tenantId: ref.tenantId, name, kind: "expense", sortOrder: Number(max?.n ?? -1) + 1 })
    .returning({ id: schema.category.id });
  if (!row) throw new Error("no se pudo crear la categoría");
  await audit(tx, ref, "create", "category", row.id, null, { name });
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
  if (await nameTaken(tx, ref.tenantId, name, id)) throw new CategoryError("duplicate");
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
};

export async function getTenantSettings(tx: Tx, tenantId: string): Promise<TenantSettings | null> {
  const [t] = await tx
    .select({
      name: schema.tenant.name,
      businessType: schema.tenant.businessType,
      defaultExpenseCurrency: schema.tenant.defaultExpenseCurrency,
    })
    .from(schema.tenant)
    .where(eq(schema.tenant.id, tenantId));
  if (!t) return null;
  return {
    name: t.name,
    businessType: t.businessType as TenantSettings["businessType"],
    defaultExpenseCurrency: (t.defaultExpenseCurrency as "USD" | "VES" | null) ?? "USD",
  };
}

/** Nombre, tipo y moneda por defecto (US-E7). El tipo no vuelve a crear categorías: solo etiqueta. */
export async function updateTenantSettings(
  tx: Tx,
  ref: { tenantId: string; userId: string },
  input: TenantSettings,
): Promise<void> {
  const name = normalize(input.name);
  if (name.length < 2 || name.length > 80) throw new CategoryError("invalid");
  const before = await getTenantSettings(tx, ref.tenantId);
  if (!before) throw new CategoryError("missing");
  const after = { ...input, name };
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  await tx
    .update(schema.tenant)
    .set({
      name,
      businessType: input.businessType,
      defaultExpenseCurrency: input.defaultExpenseCurrency,
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
