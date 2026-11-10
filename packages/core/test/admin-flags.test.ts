import { describe, expect, it } from "vitest";
import {
  APPROVALS,
  applyFlagChange,
  dependentsOn,
  FLAG_RULES,
  type FlagState,
  missingNeeds,
  validateFlagSave,
} from "../src/admin/flags";

/** Interruptores de /admin (rediseño 08/11): dependencias, aprobaciones y los que no se tocan. */
const OFF: FlagState = {
  streakLine: false,
  noSpend: false,
  prefs: false,
  nudge: false,
  dailyClose: false,
  reminders: false,
  xp: false,
  rewards: false,
  referrals: false,
  inWindow: false,
  template: false,
  viaTemplate: false,
};
/** Producción el 08/11: hábito encendido, P4 apagado. */
const PROD: FlagState = {
  ...OFF,
  streakLine: true,
  noSpend: true,
  prefs: true,
  nudge: true,
  dailyClose: true,
  reminders: true,
  inWindow: true,
};

describe("dependencias", () => {
  it("bloquea encender sin aquello de lo que depende", () => {
    expect(missingNeeds("dailyClose", OFF)).toEqual(["prefs", "nudge"]);
    expect(missingNeeds("rewards", PROD)).toEqual(["xp"]);
    expect(applyFlagChange(OFF, "nudge", true, "A-0033")).toEqual({
      ok: false,
      error: "needs",
      missing: ["prefs"],
    });
  });

  it("apagar uno apaga los que dependen de él (directa o indirectamente)", () => {
    expect(dependentsOn("nudge", PROD)).toEqual(["dailyClose"]);
    const r = applyFlagChange(PROD, "nudge", false);
    expect(r).toMatchObject({ ok: true, alsoOff: ["dailyClose"] });
    if (r.ok) expect(r.next).toMatchObject({ nudge: false, dailyClose: false, prefs: true });
  });

  it("el servidor rechaza guardar un encendido sin su dependencia", () => {
    expect(validateFlagSave(PROD, { ...PROD, nudge: false })).toMatchObject({
      ok: false,
      error: "needs",
      key: "dailyClose",
    });
    expect(validateFlagSave(PROD, { ...PROD, nudge: false, dailyClose: false })).toEqual({
      ok: true,
      approval: null,
    });
  });
});

describe("código de aprobación", () => {
  it("una aprobación pendiente no deja encender, ni con el código", () => {
    // Invitaciones (A-0039-T2) sigue pendiente; Puntos ya no lo bloquea.
    expect(APPROVALS["A-0039-T2"].status).toBe("pending");
    const withXp = { ...PROD, xp: true };
    expect(applyFlagChange(withXp, "referrals", true, "A-0039-T2")).toEqual({
      ok: false,
      error: "approval_pending",
    });
    expect(validateFlagSave(withXp, { ...withXp, referrals: true }, "A-0039-T2")).toMatchObject({
      ok: false,
      error: "approval_pending",
    });
  });

  it("Puntos y Premios (A-0039-T1, aprobada): encienden solo con su código exacto", () => {
    expect(APPROVALS["A-0039-T1"].status).toBe("approved");
    expect(applyFlagChange(PROD, "xp", true, "A-0039-T2")).toMatchObject({
      ok: false,
      error: "approval_code",
    });
    expect(applyFlagChange(PROD, "xp", true, "A-0039-T1")).toMatchObject({ ok: true });
    // Premios necesita Puntos encendido antes.
    expect(applyFlagChange(PROD, "rewards", true, "A-0039-T1")).toMatchObject({
      ok: false,
      error: "needs",
    });
  });

  it("con la aprobación vigente, sin el código exacto no se enciende", () => {
    const off = { ...PROD, nudge: false, dailyClose: false };
    for (const code of [undefined, "", "a-0033", "A-033", "A-0033x"])
      expect(applyFlagChange(off, "nudge", true, code)).toEqual({
        ok: false,
        error: "approval_code",
      });
    expect(validateFlagSave(off, { ...off, nudge: true }, "A-0034")).toMatchObject({
      ok: false,
      error: "approval_code",
    });
    expect(applyFlagChange(off, "nudge", true, "A-0033")).toMatchObject({
      ok: true,
      approval: "A-0033",
    });
    expect(validateFlagSave(off, { ...off, nudge: true }, " A-0033 ")).toEqual({
      ok: true,
      approval: "A-0033",
    });
  });

  it("apagar nunca pide código", () => {
    expect(validateFlagSave(PROD, { ...PROD, reminders: false })).toEqual({
      ok: true,
      approval: null,
    });
    expect(applyFlagChange(PROD, "reminders", false)).toMatchObject({ ok: true });
  });

  it("un encendido con su aprobación pendiente se puede dejar como está", () => {
    // `dailyClose` (A-0038) y `reminders` (A-0037) ya están encendidos: guardar otro cambio no falla.
    expect(validateFlagSave(PROD, { ...PROD, streakLine: false })).toEqual({
      ok: true,
      approval: null,
    });
  });
});

describe("los que no se tocan", () => {
  it("«Avisos» no se apaga", () => {
    expect(applyFlagChange(PROD, "prefs", false)).toEqual({ ok: false, error: "sticky" });
    expect(validateFlagSave(PROD, { ...PROD, prefs: false })).toMatchObject({
      ok: false,
      error: "sticky",
      key: "prefs",
    });
    // Encenderlo sí (va primero).
    expect(applyFlagChange(OFF, "prefs", true)).toMatchObject({ ok: true });
  });

  it("«Plantilla (lote)» no se enciende a mano, pero sí se apaga (freno del lote)", () => {
    expect(applyFlagChange(PROD, "template", true)).toEqual({ ok: false, error: "managed" });
    expect(validateFlagSave({ ...PROD, template: true }, PROD)).toEqual({
      ok: true,
      approval: null,
    });
  });

  it("«Recordatorio como plantilla» no se enciende (no aprobado)", () => {
    expect(applyFlagChange(PROD, "viaTemplate", true)).toEqual({ ok: false, error: "blocked" });
    expect(validateFlagSave(PROD, { ...PROD, viaTemplate: true })).toMatchObject({
      ok: false,
      error: "blocked",
    });
  });

  it("cada aprobación que pide un interruptor está en la lista fija", () => {
    for (const r of FLAG_RULES) if (r.approval) expect(APPROVALS[r.approval]).toBeDefined();
  });

  it("estado real de producción (10/11): guardar sin cambios pasa y el freno del lote funciona", () => {
    const live = {
      ...OFF,
      streakLine: true,
      noSpend: true,
      prefs: true,
      nudge: true,
      dailyClose: true,
      reminders: true,
      inWindow: true,
      template: true,
    };
    // Guardar cualquier grupo tal cual: dailyClose y reminders siguen encendidos aunque su
    // aprobación esté pendiente, y «Plantilla (lote)» encendida por el lote.
    expect(validateFlagSave(live, live)).toMatchObject({ ok: true });
    // Apagar «Plantilla (lote)» frena el lote, sin código.
    expect(validateFlagSave(live, { ...live, template: false })).toMatchObject({ ok: true });
    // Apagar «8 pm para todos» (A-0038) tampoco pide código.
    expect(validateFlagSave(live, { ...live, dailyClose: false })).toMatchObject({ ok: true });
  });
});
