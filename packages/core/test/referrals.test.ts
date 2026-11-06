import { randomUUID } from "node:crypto";
import { and, eq, rows, schema, sql, withTenant } from "@caja/db";
import { seedTenant } from "@caja/db/seed";
import { createTestDb } from "@caja/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approvePayment, recordPayment } from "../src/billing/payments";
import {
  approveRefMonth,
  attachReferral,
  codeCheck,
  grantInviteeMessages,
  inviterSweep,
  isCodeShape,
  lateCode,
  myPeople,
  newCode,
  parseInviteCode,
  ReviewRefused,
  referralCodeFor,
  refuseRefMonth,
  syncInvitee,
} from "../src/billing/referrals";
import { saveRewardSettings } from "../src/billing/rewards";
import { trialMessageCap } from "../src/billing/trial";
import { businessDateOf } from "../src/domain/dates";
import { Decimal } from "../src/domain/money";
import { saveHabitSettings } from "../src/ledger/habits";
import { handleSignup } from "../src/onboarding/chat-signup";
import { eraseTenant } from "../src/onboarding/erase";
import { inviteReply, lateCodeReply } from "../src/render/points-es";

/**
 * Invitaciones (PRD hábitos v4.2.1, P4-B: US-412, US-418, US-419, US-421, US-422, US-423). Las
 * funciones de 0036 con su RLS, la unión, los pasos, el lado del que invita y el mes de regalo.
 */
const DAY = 86_400_000;
const reviewer = { userId: randomUUID(), email: "admin@ejemplo.com" };

describe("invitaciones (P4-B)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let n = 0;
  beforeAll(async () => {
    t = await createTestDb();
    await t.db.insert(schema.userAccount).values({ id: reviewer.userId, email: reviewer.email });
  });
  afterAll(() => t.close());
  beforeEach(async () => {
    await saveHabitSettings(t.db, { xp: true, rewards: true, referrals: true }, "test", new Date());
    await saveRewardSettings(
      t.db,
      { xpOnSince: "2020-01-01" as never, referralsOnSince: "2020-01-01" as never },
      "test",
      new Date(),
    );
  });

  async function tenant(opts: Partial<typeof schema.tenant.$inferInsert> = {}) {
    const phone = `58414${String(1_000_000 + ++n)}`;
    const id = await seedTenant(t.db, { name: "N", businessType: "retail", ownerPhone: phone });
    if (Object.keys(opts).length)
      await withTenant(t.db, id, (tx) =>
        tx.update(schema.tenant).set(opts).where(eq(schema.tenant.id, id)),
      );
    const owner = await withTenant(t.db, id, async (tx) => {
      const [p] = await tx.select().from(schema.phoneNumber);
      return p?.id ?? "";
    });
    return { id, owner, phone };
  }
  const record = (tn: { id: string; owner: string }, at: Date) =>
    withTenant(t.db, tn.id, (tx) =>
      tx.insert(schema.movement).values({
        tenantId: tn.id,
        type: "expense",
        amount: "1.00",
        currency: "USD",
        amountUsd: "1.00",
        amountVes: "200.00",
        rateValue: "200.00000000",
        rateSource: "manual",
        businessDate: businessDateOf(at),
        paymentMethod: "unspecified",
        origin: "single",
        sourceChannel: "text",
        createdByPhoneId: tn.owner,
        createdAt: at,
      }),
    );
  /** Quien invita: 3 días con registro y su código. */
  async function inviter(opts: Partial<typeof schema.tenant.$inferInsert> = {}) {
    const a = await tenant(opts);
    for (const d of [1, 2, 3]) await record(a, new Date(Date.now() - d * DAY));
    const code = await withTenant(t.db, a.id, (tx) => referralCodeFor(tx, a.id));
    return { ...a, code: code as string };
  }
  const pay = (id: string, at: Date, approve = true) =>
    withTenant(t.db, id, (tx) =>
      recordPayment(
        tx,
        {
          tenantId: id,
          plan: "personal",
          months: 1,
          method: "zelle",
          amount: new Decimal("5.99"),
          currency: "USD",
          rateKind: null,
          rateValue: null,
          amountUsd: new Decimal("5.99"),
          reference: null,
          notes: null,
        },
        reviewer,
        at,
        { approve },
      ),
    );
  const sweep = (id: string, now = new Date()) =>
    withTenant(t.db, id, (tx) => inviterSweep(tx, id, now));
  const referralsOf = (inviterId: string) =>
    withTenant(t.db, inviterId, (tx) =>
      tx.select().from(schema.referral).where(eq(schema.referral.tenantId, inviterId)),
    );
  const grantsOf = (id: string) =>
    withTenant(t.db, id, (tx) =>
      tx.select().from(schema.rewardGrant).where(eq(schema.rewardGrant.tenantId, id)),
    );
  const pointsOf = async (id: string, rule: string) =>
    (
      await withTenant(t.db, id, (tx) =>
        tx
          .select()
          .from(schema.pointsEvent)
          .where(and(eq(schema.pointsEvent.tenantId, id), eq(schema.pointsEvent.rule, rule))),
      )
    ).reduce((a, e) => a + e.points, 0);
  const tenantRow = async (id: string) =>
    (
      await withTenant(t.db, id, (tx) =>
        tx.select().from(schema.tenant).where(eq(schema.tenant.id, id)),
      )
    )[0];
  const notices = (id: string) =>
    withTenant(t.db, id, (tx) =>
      tx.select().from(schema.pointsNotice).where(eq(schema.pointsNotice.tenantId, id)),
    );

  it("el código: 6 del alfabeto, 2 dígitos; las frases del primer mensaje", () => {
    for (let i = 0; i < 200; i++) expect(isCodeShape(newCode())).toBe(true);
    expect(isCodeShape("PRUEBA")).toBe(false);
    expect(isCodeShape("RK4M7Q")).toBe(true);
    expect(isCodeShape("RK4M7O")).toBe(false);
    expect(parseInviteCode("Hola Rocco, me invitó K7M2QX", { alone: false })).toBe("K7M2QX");
    expect(parseInviteCode("hola rocco", { alone: false })).toBeNull();
    expect(parseInviteCode("PRUEBA", { alone: true })).toBeNull();
    expect(parseInviteCode("rk4m7q", { alone: true })).toBe("RK4M7Q");
    expect(parseInviteCode("mi código es el rk4m7q", { alone: false })).toBe("RK4M7Q");
  });

  it("sin 3 días con registro no hay código (P-3); un código mal escrito no consulta nada", async () => {
    const a = await tenant();
    await record(a, new Date(Date.now() - DAY));
    expect(await withTenant(t.db, a.id, (tx) => referralCodeFor(tx, a.id))).toBeNull();
    expect(await withTenant(t.db, a.id, (tx) => codeCheck(tx, "R!"))).toBe("none");
    const b = await inviter();
    expect(await withTenant(t.db, a.id, (tx) => codeCheck(tx, b.code))).toBe("ok");
  });

  it("unión, +50, activo (+50), pagó (+100 y mes en revisión), aprobado a los 7 días", async () => {
    const a = await inviter({ status: "active", paidUntil: new Date(Date.now() + 10 * DAY) });
    const b = await tenant();
    const r = await withTenant(t.db, b.id, (tx) => attachReferral(tx, a.code, "web"));
    expect(r).toBe("attached");
    const tope = await withTenant(t.db, b.id, (tx) => grantInviteeMessages(tx, b.id, new Date()));
    expect(tope).toBe(50);
    const bt = await tenantRow(b.id);
    expect(trialMessageCap(bt as never)).toBe(150);
    // Una sola vez.
    expect(await withTenant(t.db, b.id, (tx) => attachReferral(tx, a.code, "late"))).toBe(
      "already",
    );

    await record(b, new Date());
    await withTenant(t.db, b.id, (tx) => syncInvitee(tx));
    await sweep(a.id);
    expect(await pointsOf(a.id, "ref_active")).toBe(50);
    expect((await notices(a.id)).map((x) => x.kind)).toContain("ref_active");

    // Pago aprobado hace 8 días (dentro de 90 desde el registro).
    await pay(b.id, new Date(Date.now() - 8 * DAY));
    await withTenant(t.db, b.id, (tx) => syncInvitee(tx));
    expect((await referralsOf(a.id))[0]?.stage).toBe("paid");
    await sweep(a.id);
    expect(await pointsOf(a.id, "ref_paid")).toBe(100);
    const [g] = (await grantsOf(a.id)).filter((x) => x.kind === "ref_month");
    expect(g?.status).toBe("pending_review");
    const before = (await tenantRow(a.id))?.paidUntil;
    expect(
      await withTenant(t.db, a.id, (tx) =>
        approveRefMonth(tx, a.id, g?.id as string, reviewer, new Date()),
      ),
    ).toBe("applied");
    const after = (await tenantRow(a.id))?.paidUntil;
    expect((after?.getTime() ?? 0) - (before?.getTime() ?? 0)).toBe(30 * DAY);
    // Aprobar otra vez → rechazado (ya no está en revisión).
    await expect(
      withTenant(t.db, a.id, (tx) =>
        approveRefMonth(tx, a.id, g?.id as string, reviewer, new Date()),
      ),
    ).rejects.toBeInstanceOf(ReviewRefused);
    expect((await notices(a.id)).map((x) => x.kind)).toContain("ref_paid");
    // «Mi gente»: Persona 1, pagó.
    expect(await withTenant(t.db, a.id, (tx) => myPeople(tx, a.id))).toEqual([
      { n: 1, stage: "paid" },
    ]);
  });

  it("aprobar el día 6 → rechazado; un rechazo → RW8e y el +100 se queda", async () => {
    const a = await inviter({ status: "active", paidUntil: new Date(Date.now() + 10 * DAY) });
    const b = await tenant();
    await withTenant(t.db, b.id, (tx) => attachReferral(tx, a.code, "chat"));
    await pay(b.id, new Date(Date.now() - 6 * DAY));
    await withTenant(t.db, b.id, (tx) => syncInvitee(tx));
    await sweep(a.id);
    const [g] = (await grantsOf(a.id)).filter((x) => x.kind === "ref_month");
    const e = await withTenant(t.db, a.id, (tx) =>
      approveRefMonth(tx, a.id, g?.id as string, reviewer, new Date()),
    ).catch((x) => x);
    expect(e).toBeInstanceOf(ReviewRefused);
    expect((e as ReviewRefused).reason).toBe("too_soon");
    await withTenant(t.db, a.id, (tx) => refuseRefMonth(tx, a.id, g?.id as string, new Date()));
    expect((await notices(a.id)).map((x) => x.kind)).toContain("ref_refused");
    expect(await pointsOf(a.id, "ref_paid")).toBe(100);
    await expect(
      withTenant(t.db, a.id, (tx) =>
        approveRefMonth(tx, a.id, g?.id as string, reviewer, new Date()),
      ),
    ).rejects.toBeInstanceOf(ReviewRefused);
    expect(await withTenant(t.db, a.id, (tx) => myPeople(tx, a.id))).toEqual([]);
  });

  it("quien invita en la prueba: el mes espera y se suma con su primer pago", async () => {
    const a = await inviter();
    const b = await tenant();
    await withTenant(t.db, b.id, (tx) => attachReferral(tx, a.code, "web"));
    await pay(b.id, new Date(Date.now() - 8 * DAY));
    await withTenant(t.db, b.id, (tx) => syncInvitee(tx));
    await sweep(a.id);
    const [g] = (await grantsOf(a.id)).filter((x) => x.kind === "ref_month");
    expect(
      await withTenant(t.db, a.id, (tx) =>
        approveRefMonth(tx, a.id, g?.id as string, reviewer, new Date()),
      ),
    ).toBe("waiting");
    const p = await pay(a.id, new Date());
    const [g2] = (await grantsOf(a.id)).filter((x) => x.kind === "ref_month");
    expect(g2?.status).toBe("applied");
    const at = await tenantRow(a.id);
    // 30 del pago + 30 del regalo, desde el fin de la prueba.
    const from = Math.max(Date.now(), at?.trialEndsAt?.getTime() ?? 0);
    expect(Math.round(((at?.paidUntil?.getTime() ?? 0) - from) / DAY)).toBe(60);
    expect(p.paymentId).toBeTruthy();
  });

  it("devolución antes de aplicar el mes → cancelado, −100, RW8f; dos → código pausado (RW8g)", async () => {
    const a = await inviter({ status: "active", paidUntil: new Date(Date.now() + 10 * DAY) });
    const reverse = async (bId: string, paymentId: string) => {
      await withTenant(t.db, bId, (tx) =>
        tx
          .update(schema.payment)
          .set({ status: "reversed", reversedAt: new Date() })
          .where(eq(schema.payment.id, paymentId)),
      );
      await withTenant(t.db, bId, (tx) => syncInvitee(tx));
      await sweep(a.id);
    };
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const b = await tenant();
      await withTenant(t.db, b.id, (tx) => attachReferral(tx, a.code, "web"));
      const p = await pay(b.id, new Date(Date.now() - 8 * DAY));
      await withTenant(t.db, b.id, (tx) => syncInvitee(tx));
      await sweep(a.id);
      ids.push(b.id, p.paymentId);
    }
    // La primera: el mes ya aplicado → sin línea (F-1).
    const grants = (await grantsOf(a.id)).filter((x) => x.kind === "ref_month");
    await withTenant(t.db, a.id, (tx) =>
      approveRefMonth(tx, a.id, grants[0]?.id as string, reviewer, new Date()),
    );
    const appliedFor = grants[0]?.referralId;
    const refs = await referralsOf(a.id);
    const first = refs.find((r) => r.id === appliedFor);
    const second = refs.find((r) => r.id !== appliedFor);
    const pairs = [ids.slice(0, 2), ids.slice(2, 4)];
    const pairOf = (inv: string | undefined) => pairs.find((p) => p[0] === inv) as string[];
    const p1 = pairOf(first?.inviteeTenantId);
    await reverse(p1[0] as string, p1[1] as string);
    expect((await notices(a.id)).map((x) => x.kind)).not.toContain("ref_reversed");
    expect(await pointsOf(a.id, "ref_paid")).toBe(200);
    // La segunda: en revisión → cancelada, −100, RW8f; y con dos, el código se pausa.
    const p2 = pairOf(second?.inviteeTenantId);
    await reverse(p2[0] as string, p2[1] as string);
    const kinds = (await notices(a.id)).map((x) => x.kind);
    expect(kinds).toContain("ref_reversed");
    expect(kinds).toContain("code_paused");
    expect(await pointsOf(a.id, "ref_paid")).toBe(100);
    const [code] = await withTenant(t.db, a.id, (tx) =>
      tx.select().from(schema.referralCode).where(eq(schema.referralCode.tenantId, a.id)),
    );
    expect(code?.disabledReason).toBe("reversals");
    // Pausado: no une a nadie más.
    const c = await tenant();
    expect(await withTenant(t.db, c.id, (tx) => attachReferral(tx, a.code, "web"))).toBe(
      "not_found",
    );
  });

  it("número que ya usó Rocco → returning, sin regalos; su propio código no", async () => {
    const a = await inviter();
    const b = await tenant();
    await t.db.insert(schema.signup).values({ e164: b.phone, step: "name", data: {} });
    expect(await withTenant(t.db, b.id, (tx) => attachReferral(tx, a.code, "web"))).toBe(
      "returning",
    );
    expect(await withTenant(t.db, a.id, (tx) => attachReferral(tx, a.code, "web"))).toBe("invalid");
    expect(await withTenant(t.db, a.id, (tx) => myPeople(tx, a.id))).toEqual([]);
  });

  it("el séptimo que paga en 12 meses no suma mes ni puntos (RW8d)", async () => {
    const a = await inviter({ status: "active", paidUntil: new Date(Date.now() + 10 * DAY) });
    for (let i = 0; i < 7; i++) {
      const b = await tenant();
      await withTenant(t.db, b.id, (tx) => attachReferral(tx, a.code, "web"));
      await pay(b.id, new Date(Date.now() - 8 * DAY));
      await withTenant(t.db, b.id, (tx) => syncInvitee(tx));
      await sweep(a.id);
    }
    const months = (await grantsOf(a.id)).filter((x) => x.kind === "ref_month");
    expect(months.filter((g) => g.status === "pending_review")).toHaveLength(6);
    expect(months.filter((g) => g.status === "cancelled")).toHaveLength(1);
    expect(await pointsOf(a.id, "ref_paid")).toBe(600);
    expect((await notices(a.id)).map((x) => x.kind)).toContain("ref_capped");
  });

  it("código tardío: 7 días, 3 intentos, nunca después de un pago aprobado", async () => {
    const a = await inviter();
    const b = await tenant();
    const late = (text: string) =>
      withTenant(t.db, b.id, (tx) => lateCode(tx, b.id, text, new Date()));
    expect((await late("me invitó ZZZ22Z")).kind).toBe("not_found");
    expect((await late("me invitó ZZZ23Z")).kind).toBe("not_found");
    const ok = await late(`me invitó ${a.code}`);
    expect(ok).toMatchObject({ kind: "attached", tope: 50 });
    expect((await late(`me invitó ${a.code}`)).kind).toBe("closed");
    const c = await tenant();
    await pay(c.id, new Date());
    expect(
      (await withTenant(t.db, c.id, (tx) => lateCode(tx, c.id, `me invitó ${a.code}`, new Date())))
        .kind,
    ).toBe("closed");
    const d = await tenant({ createdAt: new Date(Date.now() - 8 * DAY) });
    expect(
      (await withTenant(t.db, d.id, (tx) => lateCode(tx, d.id, `me invitó ${a.code}`, new Date())))
        .kind,
    ).toBe("too_late");
  });

  it("RLS: caja_app no lee las invitaciones de otro ni escribe un paso", async () => {
    const a = await inviter();
    const b = await tenant();
    await withTenant(t.db, b.id, (tx) => attachReferral(tx, a.code, "web"));
    const asApp = <T>(
      tenantId: string,
      fn: (tx: Parameters<Parameters<typeof t.db.transaction>[0]>[0]) => Promise<T>,
    ) =>
      t.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
        await tx.execute(sql`set local role caja_app`);
        return fn(tx);
      });
    // El invitado no ve la fila (es del que invita).
    expect(await asApp(b.id, (tx) => tx.select().from(schema.referral))).toEqual([]);
    expect((await asApp(a.id, (tx) => tx.select().from(schema.referral))).length).toBe(1);
    // Nadie escribe un paso a mano.
    await expect(
      asApp(a.id, (tx) => tx.execute(sql`update app.referral set stage = 'paid'`)),
    ).rejects.toThrow();
    // Sin pago aprobado, la función no marca «pagó».
    await asApp(b.id, (tx) => tx.execute(sql`select app.referral_sync_invitee()`));
    expect((await referralsOf(a.id))[0]?.stage).toBe("signed_up");
    // La función interna del dueño del código no es de caja_app.
    await expect(
      asApp(b.id, (tx) => tx.execute(sql`select app.referral_code_owner(${a.code})`)),
    ).rejects.toThrow();
  });

  it("borrar a cualquiera de los dos borra la invitación; el regalo queda sin referral_id", async () => {
    const a = await inviter({ status: "active", paidUntil: new Date(Date.now() + 10 * DAY) });
    const b = await tenant();
    await withTenant(t.db, b.id, (tx) => attachReferral(tx, a.code, "web"));
    await pay(b.id, new Date(Date.now() - 8 * DAY));
    await withTenant(t.db, b.id, (tx) => syncInvitee(tx));
    await sweep(a.id);
    await withTenant(t.db, b.id, (tx) => eraseTenant(tx, b.id));
    expect(await referralsOf(a.id)).toEqual([]);
    const [g] = (await grantsOf(a.id)).filter((x) => x.kind === "ref_month");
    expect([g?.referralId, g?.paymentId, g?.status]).toEqual([null, null, "pending_review"]);
    expect(g?.sourceApprovedAt).toBeTruthy();
    const left = rows<{ n: number }>(
      await t.db.execute(
        sql`select count(*)::int as n from app.referral where invitee_tenant_id = ${b.id}`,
      ),
    );
    expect(left[0]?.n).toBe(0);
  });

  it("registro por chat con código: RW6i y 150 antes del nombre; la invitación con la cuenta", async () => {
    const a = await inviter();
    const e164 = "584169990001";
    const input = (text: string | null, replyId: string | null = null) => ({
      e164,
      waUserId: null,
      profileName: "Ana",
      text,
      replyId,
    });
    const first = await handleSignup(t.db, input(`Hola Rocco, me invitó ${a.code}`), {
      dashboardUrl: "https://x.test",
    });
    const intro = String((first.outbound[0] as { body: string }).body);
    expect(intro).toContain("*31 días o 150 mensajes gratis*");
    expect(intro).toContain("_Llegaste con la invitación de alguien que usa Rocco:");
    const [row] = await t.db.select().from(schema.signup).where(eq(schema.signup.e164, e164));
    expect(row?.data).toEqual({ ref: a.code });
    // Sin cuenta todavía, ninguna fila `referral` (P-4).
    expect(await referralsOf(a.id)).toEqual([]);
    await t.db
      .update(schema.signup)
      .set({
        step: "budget",
        data: {
          ref: a.code,
          name: "Ana",
          kind: "personal",
          businessType: "personal",
          currency: "USD",
          categories: ["Comida"],
          accounts: [],
        },
      })
      .where(eq(schema.signup.e164, e164));
    const done = await handleSignup(t.db, input(null, "signup:bud:skip"), {
      dashboardUrl: "https://x.test",
    });
    expect(String((done.outbound[0] as { body: string }).body)).toContain("150 mensajes");
    const tenantId = done.created?.tenantId as string;
    const [b] = await withTenant(t.db, tenantId, (tx) =>
      tx.select().from(schema.tenant).where(eq(schema.tenant.id, tenantId)),
    );
    expect(b?.extraMessages).toBe(50);
    expect((await referralsOf(a.id)).map((r) => r.via)).toEqual(["chat"]);
  });

  it("primer mensaje sin código, o con un código que no existe: el registro de siempre", async () => {
    for (const text of ["hola rocco", "Hola Rocco, me invitó ZZ22ZZ", "PRUEBA"]) {
      const out = await handleSignup(
        t.db,
        {
          e164: `58416999${String(1000 + ++n)}`,
          waUserId: null,
          profileName: null,
          text,
          replyId: null,
        },
        { dashboardUrl: "https://x.test" },
      );
      const body = String((out.outbound[0] as { body: string }).body);
      expect(body).toContain("*31 días o 100 mensajes gratis*");
      expect(body).not.toContain("invitación");
    }
  });

  it("textos RW-late y RW4-i (v1.2)", () => {
    expect(lateCodeReply({ kind: "attached", code: "RK4M7Q", tope: 50 }).body).toBe(
      "Listo, quedó anotado que te invitó RK4M7Q. Tu prueba ahora trae 50 mensajes más: son 150. Si pagas tu primer mes en los 90 días desde tu registro, esa persona recibe un mes de regalo. Y solo verá en qué paso vas, nunca tu nombre, tu número, tus montos ni tus movimientos.",
    );
    expect(lateCodeReply({ kind: "closed" }).body).toBe(
      "Ya no se puede agregar un código de invitación a esta cuenta. Las reglas: holarocco.com/puntos",
    );
    const two = inviteReply({ code: "RK4M7Q" });
    expect(two).toHaveLength(2);
    expect(String((two[1] as { body: string }).body).endsWith("holarocco.com/?ref=RK4M7Q")).toBe(
      true,
    );
    expect(inviteReply("not_eligible")[0]).toEqual({
      type: "text",
      body: "Tu enlace para invitar aparece cuando hayas anotado algo en 3 días distintos.",
    });
  });
});
