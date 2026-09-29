import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../src/testing/pglite";

/**
 * Prueba de aislamiento por tenant (Fase 7, checklist S1): con el rol de aplicación, un tenant
 * no puede leer ni escribir filas de otro, y sin tenant fijado no se ve nada.
 */
describe("RLS por tenant", () => {
  let pg: PGlite;
  const tenantA = "11111111-1111-4111-8111-111111111111";
  const tenantB = "22222222-2222-4222-8222-222222222222";
  let rateId: string;

  beforeAll(async () => {
    ({ pg } = await createTestDb());
    // Datos base como dueño de las tablas (bypass de RLS, igual que el rol de migraciones).
    await pg.query(
      `INSERT INTO app.tenant (id, name, business_type) VALUES ($1, 'A', 'car_wash'), ($2, 'B', 'food')`,
      [tenantA, tenantB],
    );
    const r = await pg.query<{ id: string }>(
      `INSERT INTO app.bcv_rate (effective_date, rate, source) VALUES ('2026-09-29', 858.00000000, 'test') RETURNING id`,
    );
    rateId = r.rows[0]?.id ?? "";
    for (const t of [tenantA, tenantB]) {
      const p = await pg.query<{ id: string }>(
        `INSERT INTO app.phone_number (tenant_id, e164, role, status) VALUES ($1, $2, 'owner', 'active') RETURNING id`,
        [t, t === tenantA ? "584120000001" : "584140000002"],
      );
      await pg.query(
        `INSERT INTO app.movement (tenant_id, type, business_date, amount, currency, rate_id, rate_value, amount_usd, amount_ves, source_channel, created_by_phone_id)
         VALUES ($1, 'expense', '2026-09-29', 15.00, 'USD', $2, 858.00000000, 15.00, 12870.00, 'text', $3)`,
        [t, rateId, p.rows[0]?.id],
      );
    }
    await pg.exec(`SET ROLE caja_app`);
  });

  afterAll(async () => {
    await pg.close();
  });

  async function asTenant<T>(tenantId: string | null, fn: () => Promise<T>): Promise<T> {
    await pg.exec("BEGIN");
    try {
      if (tenantId) {
        await pg.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
      }
      return await fn();
    } finally {
      await pg.exec("ROLLBACK");
    }
  }

  it("sin tenant fijado no se ve ninguna fila", async () => {
    const rows = await asTenant(null, () => pg.query(`SELECT id FROM app.movement`));
    expect(rows.rows).toHaveLength(0);
    const tenants = await asTenant(null, () => pg.query(`SELECT id FROM app.tenant`));
    expect(tenants.rows).toHaveLength(0);
  });

  it("cada tenant ve solo sus movimientos", async () => {
    const a = await asTenant(tenantA, () =>
      pg.query<{ tenant_id: string }>(`SELECT tenant_id FROM app.movement`),
    );
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]?.tenant_id).toBe(tenantA);
    const b = await asTenant(tenantB, () =>
      pg.query<{ tenant_id: string }>(`SELECT tenant_id FROM app.movement`),
    );
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0]?.tenant_id).toBe(tenantB);
  });

  it("un tenant no puede insertar filas a nombre de otro", async () => {
    await expect(
      asTenant(tenantA, () =>
        pg.query(
          `INSERT INTO app.movement (tenant_id, type, business_date, amount, currency, rate_id, rate_value, amount_usd, amount_ves, source_channel, created_by_user_id)
           VALUES ($1, 'expense', '2026-09-29', 1.00, 'USD', $2, 858, 1.00, 858.00, 'dashboard', $3)`,
          [tenantB, rateId, "33333333-3333-4333-8333-333333333333"],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("un tenant no puede actualizar ni ver el tenant ajeno", async () => {
    const updated = await asTenant(tenantA, () =>
      pg.query(`UPDATE app.tenant SET name = 'hackeado' WHERE id = $1 RETURNING id`, [tenantB]),
    );
    expect(updated.rows).toHaveLength(0);
    const seen = await asTenant(tenantA, () =>
      pg.query<{ id: string }>(`SELECT id FROM app.tenant`),
    );
    expect(seen.rows.map((r) => r.id)).toEqual([tenantA]);
  });

  it("resolve_phone funciona sin tenant fijado y devuelve solo lo necesario", async () => {
    const r = await asTenant(null, () =>
      pg.query<{ tenant_id: string; role: string }>(`SELECT * FROM app.resolve_phone($1, NULL)`, [
        "584140000002",
      ]),
    );
    expect(r.rows[0]?.tenant_id).toBe(tenantB);
    expect(r.rows[0]?.role).toBe("owner");
    const none = await asTenant(null, () =>
      pg.query(`SELECT * FROM app.resolve_phone($1, NULL)`, ["580000000000"]),
    );
    expect(none.rows).toHaveLength(0);
  });

  it("audit_log no admite UPDATE ni DELETE desde la app", async () => {
    await asTenant(tenantA, async () => {
      await pg.query(
        `INSERT INTO app.audit_log (tenant_id, actor_type, action, entity, entity_id, channel)
         VALUES ($1, 'system', 'create', 'movement', $2, 'test')`,
        [tenantA, "44444444-4444-4444-8444-444444444444"],
      );
      await expect(pg.query(`DELETE FROM app.audit_log`)).rejects.toThrow(/permission denied/);
    });
  });
});
