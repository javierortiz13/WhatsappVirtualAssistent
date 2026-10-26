import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scrubErrorText, scrubLogFields, scrubSentryEvent } from "../src/log";

/** ER-3 (revisión de hábitos): un error de la base no saca a Sentry ni a los logs lo que escribió el usuario. */
describe("scrubErrorText", () => {
  const drizzle =
    'Failed query: insert into "app"."message" ("tenant_id", "body") values ($1, $2)\nparams: 7d0e…,gasté 15$ en el regalo de mi novia';
  it("quita los parámetros de la consulta y deja la consulta", () => {
    const out = scrubErrorText(drizzle);
    expect(out).toContain('insert into "app"."message"');
    expect(out).not.toMatch(/novia|7d0e/);
    expect(out).toMatch(/params: \[omitidos\]$/);
  });
  it("quita la fila y la llave de Postgres, cada una en su línea como las reporta", () => {
    const pg =
      'new row violates check constraint "x".\nFailing row contains (abc, pagar la luz a Pedro, 25.00).\nKey (e164)=(584121234567) already exists.';
    const out = scrubErrorText(pg);
    expect(out).not.toMatch(/Pedro|584121234567/);
    expect(out).toContain('new row violates check constraint "x".');
    expect(out).toContain("Failing row contains (…)");
    expect(out).toContain("Key (e164)=(…) already exists.");
  });
  it("un paréntesis dentro del texto del usuario no se escapa (S-2)", () => {
    for (const text of [
      "Failing row contains (abc, pagué la luz (casa) de Pedro, 25.00).",
      "Key (body)=(la luz (casa) de Pedro) already exists.",
      'Key (body)=(la luz (casa) de Pedro) is not present in table "x".',
      "Key (body)=(la luz (casa) de Pedro).",
    ])
      expect(scrubErrorText(text), text).not.toMatch(/Pedro/);
  });
  it("Sentry y el logger usan el mismo recorte", () => {
    const event = scrubSentryEvent({
      message: drizzle,
      exception: { values: [{ value: drizzle }] },
      breadcrumbs: [{ message: drizzle }, {}],
    });
    expect(event.breadcrumbs?.[0]?.message).toContain('insert into "app"."message"');
    expect(JSON.stringify(event)).not.toMatch(/novia/);
    expect(JSON.stringify(scrubLogFields({ err: drizzle, to: "58412****567" }))).not.toMatch(
      /novia/,
    );
  });
  it("Sentry sin cuerpo, query string, cookies, IP ni argumentos de consola (S-1b)", () => {
    const event = scrubSentryEvent({
      message: "x",
      request: {
        data: '{"text":{"body":"gasté 20$ en comida con Pedro"}}',
        query_string: "a=1",
        cookies: { sb: "Pedro" },
      },
      user: { ip_address: "1.2.3.4" },
      breadcrumbs: [{ message: "x", data: { arguments: ["ingesta falló … Pedro"] } }],
    });
    expect(JSON.stringify(event)).not.toMatch(/Pedro/);
    expect(JSON.stringify(event)).not.toMatch(/1\.2\.3\.4/);
    expect(JSON.stringify(event)).not.toMatch(/a=1/);
  });
});

/** SEC-1 (S-4): ningún init de Sentry del repo sale sin el recorte ni con la recolección por defecto. */
describe("Sentry.init siempre con beforeSend y dataCollection", () => {
  const root = join(__dirname, "../../..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      if (f === "node_modules" || f === "dist" || f.startsWith(".")) return [];
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|js|mjs)$/.test(f) ? [p] : [];
    });
  it("worker, servidor web y navegador; ninguno escrito de otra forma", () => {
    let calls = 0;
    const inits = [...files(join(root, "apps")), ...files(join(root, "packages"))].flatMap((f) => {
      const src = readFileSync(f, "utf8");
      calls += (src.match(/Sentry\.init\(/g) ?? []).length;
      return [...src.matchAll(/Sentry\.init\(\{([\s\S]*?)\n\s*\}\);/g)].map((m) => ({
        f,
        body: m[1] ?? "",
      }));
    });
    // Cada llamada tiene que tener la forma que se revisa abajo: una escrita distinto falla aquí.
    expect(inits.length).toBe(calls);
    expect(inits.length).toBeGreaterThanOrEqual(3);
    for (const { f, body } of inits) {
      expect(body, f).toContain("beforeSend: (event) => scrubSentryEvent(event)");
      expect(body, f).toContain("httpBodies: []");
      expect(body, f).toContain("userInfo: false");
      expect(body, f).toContain("cookies: false");
      expect(body, f).toContain("urlQueryParams: false");
    }
  });
});
