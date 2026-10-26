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
  it("quita la fila y la llave de Postgres", () => {
    const pg =
      'new row violates check constraint "x". Failing row contains (abc, pagar la luz a Pedro, 25.00). Key (e164)=(584121234567) already exists.';
    const out = scrubErrorText(pg);
    expect(out).not.toMatch(/Pedro|584121234567/);
    expect(out).toContain("Failing row contains (…)");
    expect(out).toContain("Key (e164)=(…)");
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
});

/** SEC-1: ningún `Sentry.init` del repo sale sin el recorte. */
describe("Sentry.init siempre con beforeSend", () => {
  const root = join(__dirname, "../../..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      if (f === "node_modules" || f.startsWith(".")) return [];
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
    });
  it("worker, servidor web y navegador", () => {
    const inits = files(join(root, "apps")).flatMap((f) => {
      const src = readFileSync(f, "utf8");
      return [...src.matchAll(/Sentry\.init\(\{([\s\S]*?)\n\s*\}\);/g)].map((m) => ({
        f,
        body: m[1] ?? "",
      }));
    });
    expect(inits.length).toBeGreaterThanOrEqual(3);
    for (const { f, body } of inits) {
      expect(body, f).toContain("beforeSend: (event) => scrubSentryEvent(event)");
      expect(body, f).not.toMatch(/sendDefaultPii:\s*true/);
    }
  });
});
