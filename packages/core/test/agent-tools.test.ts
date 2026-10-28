import { describe, expect, it } from "vitest";
import {
  CancelReminderInput,
  CreateReminderInput,
  UpdateReminderInput,
} from "../src/agent/reminder-tools";
import {
  ALL_TOOLS,
  AskClarificationInput,
  countUnions,
  DraftExpenseInput,
  matchCategory,
  numbersAreGrounded,
  resolveWhen,
  STRICT_TOOL_LIMIT,
  STRICT_UNION_LIMIT,
  toLlmToolDef,
  toolsForRole,
} from "../src/agent/tools";
import { asIsoDate } from "../src/domain/dates";

const cats = [
  { id: "c1", name: "Insumos de lavado" },
  { id: "c2", name: "Agua y electricidad" },
  { id: "c3", name: "Transporte y gasolina" },
  { id: "c4", name: "Otros" },
];

describe("matchCategory", () => {
  it("exacta, sin importar mayúsculas ni acentos", () => {
    expect(matchCategory(cats, "insumos de lavado")?.id).toBe("c1");
    expect(matchCategory(cats, "Agua y Electricidad")?.id).toBe("c2");
  });
  it("por solapamiento de palabras significativas", () => {
    expect(matchCategory(cats, "gasolina")?.id).toBe("c3");
    expect(matchCategory(cats, "electricidad y agua")?.id).toBe("c2");
  });
  it("null si no hay nombre o no encaja; las palabras cortas no cuentan", () => {
    expect(matchCategory(cats, null)).toBeNull();
    expect(matchCategory(cats, "Publicidad")).toBeNull();
    expect(matchCategory(cats, "de los")).toBeNull();
  });
});

describe("resolveWhen", () => {
  const today = asIsoDate("2026-09-29"); // martes
  it("null o vacío es hoy", () => {
    expect(resolveWhen(null, today)).toEqual({ date: "2026-09-29" });
    expect(resolveWhen("  ", today)).toEqual({ date: "2026-09-29" });
  });
  it("relativas y días de la semana (el más reciente)", () => {
    expect(resolveWhen("ayer", today)).toEqual({ date: "2026-09-28" });
    expect(resolveWhen("Antier", today)).toEqual({ date: "2026-09-27" });
    expect(resolveWhen("el lunes", today)).toEqual({ date: "2026-09-28" });
    expect(resolveWhen("viernes", today)).toEqual({ date: "2026-09-25" });
  });
  it("ISO directa; futura y más de 30 días se rechazan; texto raro es unknown", () => {
    expect(resolveWhen("2026-09-15", today)).toEqual({ date: "2026-09-15" });
    expect(resolveWhen("2026-09-30", today)).toEqual({ error: "future" });
    expect(resolveWhen("2026-08-01", today)).toEqual({ error: "too_old" });
    expect(resolveWhen("la semana pasada", today)).toEqual({ error: "unknown" });
  });
});

describe("numbersAreGrounded", () => {
  it("sin cifras siempre pasa", () => {
    expect(numbersAreGrounded("¿Qué compraste?", "gasté algo")).toBe(true);
  });
  it("las cifras deben existir en el texto del usuario, ignorando separadores", () => {
    expect(numbersAreGrounded("¿Los 15,50 fueron en champú?", "gasté 15,50 en algo")).toBe(true);
    expect(numbersAreGrounded("¿Fueron 1.200 bs?", "pagué 1200 de luz")).toBe(true);
    expect(numbersAreGrounded("¿Fueron 20 dólares?", "gasté 15$ en champú")).toBe(false);
  });
});

describe("definiciones de herramientas", () => {
  it("las cuatro herramientas están para ambos roles", () => {
    expect(ALL_TOOLS.map((t) => t.name)).toEqual([
      "draft_expense",
      "draft_expenses",
      "draft_income_day_total",
      "draft_income_single",
      "get_summary",
      "get_budgets",
      "renew_plan",
      "amend_last_movement",
      "delete_last_movement",
      "ask_clarification",
      "reject_out_of_scope",
      "get_bcv_rate",
      "convert_currency",
      "sum_amounts",
      "exchange_usdt",
      "get_accounts",
      "create_account",
      "transfer_between_accounts",
      "create_reminder",
      "update_reminder",
      "cancel_reminder",
    ]);
    expect(toolsForRole("employee")).toHaveLength(15);
    expect(toolsForRole("owner")).toHaveLength(18);
    // Recordatorios (hábitos P3): solo con el interruptor; el empleado solo ve create_reminder (H29).
    expect(toolsForRole("employee", true).map((t) => t.name)).toContain("create_reminder");
    expect(toolsForRole("employee", true)).toHaveLength(16);
    expect(toolsForRole("owner", true)).toHaveLength(21);
  });
  it("el JSON Schema es estricto: sin $schema, sin propiedades extra, con properties", () => {
    for (const t of ALL_TOOLS) {
      const def = toLlmToolDef(t);
      expect(def.inputSchema.$schema).toBeUndefined();
      expect(def.inputSchema.additionalProperties).toBe(false);
      expect(def.inputSchema.properties).toBeDefined();
    }
    const draft = toLlmToolDef(ALL_TOOLS[0] as (typeof ALL_TOOLS)[number]).inputSchema as {
      required: string[];
    };
    expect(draft.required).toEqual([
      "amount",
      "currency",
      "description",
      "category_name",
      "when",
      "rate",
      "corrects_draft",
    ]);
  });
  it("quita las palabras clave que strict no admite (maxItems, maxLength) y deja la validación a Zod", () => {
    const json = JSON.stringify(ALL_TOOLS.map((t) => toLlmToolDef(t)));
    expect(json).not.toMatch(/maxItems|maxLength|minLength|minItems/);
    expect(
      AskClarificationInput.safeParse({ question: "x", options: ["a", "b", "c", "d"] }).success,
    ).toBe(false);
  });

  it("no pasa del tope de herramientas estrictas (la API rechazó 13 por gramática muy grande)", () => {
    const strict = ALL_TOOLS.map((t) => toLlmToolDef(t)).filter((d) => d.strict !== false);
    expect(strict.length).toBeLessThanOrEqual(STRICT_TOOL_LIMIT);
    expect(
      ALL_TOOLS.map((t) => toLlmToolDef(t))
        .filter((d) => d.strict === false)
        .map((d) => d.name),
    ).toEqual([
      "reject_out_of_scope",
      "get_bcv_rate",
      "convert_currency",
      "sum_amounts",
      "exchange_usdt",
      "get_accounts",
      "create_account",
      "transfer_between_accounts",
      "create_reminder",
      "update_reminder",
      "cancel_reminder",
    ]);
  });

  it("el conjunto de herramientas no supera el tope de uniones del modo estricto", () => {
    for (const reminderField of [false, true]) {
      const total = ALL_TOOLS.reduce(
        (n, t) => n + countUnions(toLlmToolDef(t, { reminderField }).inputSchema),
        0,
      );
      expect(total).toBeLessThanOrEqual(STRICT_UNION_LIMIT);
    }
  });

  it("reminder (US-307) solo aparece con recordatorios entregados, y entonces es obligatorio", () => {
    const expense = ALL_TOOLS.find((t) => t.name === "draft_expense");
    const income = ALL_TOOLS.find((t) => t.name === "draft_income_single");
    for (const t of [expense, income]) {
      if (!t) throw new Error("falta la herramienta");
      const off = toLlmToolDef(t).inputSchema as {
        properties: Record<string, unknown>;
        required: string[];
      };
      expect(off.properties.reminder).toBeUndefined();
      expect(off.required).not.toContain("reminder");
      const on = toLlmToolDef(t, { reminderField: true }).inputSchema as typeof off;
      expect(on.properties.reminder).toBeDefined();
      expect(on.required).toContain("reminder");
      expect(Object.keys(on.properties).sort()).toEqual([...on.required].sort());
    }
  });

  it("draft_expense exige los campos nulos explícitos (strict)", () => {
    expect(DraftExpenseInput.safeParse({ amount: "15", description: "Champú" }).success).toBe(
      false,
    );
    expect(
      DraftExpenseInput.safeParse({
        amount: "15",
        currency: "unknown",
        description: "Champú",
        category_name: "",
        when: "",
        rate: "",
        corrects_draft: false,
      }).success,
    ).toBe(true);
  });
});

describe("herramientas de recordatorios: argumentos incompletos", () => {
  it("update_reminder y cancel_reminder aceptan que falten los campos que no cambian", () => {
    expect(UpdateReminderInput.parse({ when: "el lunes" })).toEqual({
      reminder: "",
      text: "",
      amount: "",
      currency: "unknown",
      when: "el lunes",
    });
    expect(CancelReminderInput.parse({})).toEqual({ reminder: "" });
    expect(CreateReminderInput.parse({ text: "pagar la luz", kind: "pay" })).toMatchObject({
      amount: "",
      currency: "unknown",
      counterparty: "",
      when: "",
    });
  });
});
