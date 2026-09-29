import { describe, expect, it } from "vitest";
import { pgConnection } from "../src/ssl";

describe("pgConnection", () => {
  const url =
    "postgres://caja_app.ref:p%40ss@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require";
  it("con CA en el entorno: quita sslmode y verifica con la CA", () => {
    const c = pgConnection(url, {
      DATABASE_SSL_CA: "-----BEGIN CERTIFICATE-----\\nabc\\n-----END CERTIFICATE-----",
    });
    expect(c.connectionString).not.toContain("sslmode");
    expect(c.connectionString).toContain("caja_app.ref:p%40ss@");
    expect(c.ssl).toMatchObject({ rejectUnauthorized: true });
    expect((c.ssl as { ca: string }).ca).toContain("BEGIN CERTIFICATE");
  });
  it("sin CA pero con sslmode: cifra sin verificar", () => {
    expect(pgConnection(url, {}).ssl).toEqual({ rejectUnauthorized: false });
  });
  it("sin sslmode (local): sin TLS", () => {
    const c = pgConnection("postgres://postgres@127.0.0.1:5433/caja_test", {});
    expect(c.ssl).toBeUndefined();
    expect(c.connectionString).toBe("postgres://postgres@127.0.0.1:5433/caja_test");
  });
});
