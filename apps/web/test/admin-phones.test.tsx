import { Decimal, PLANS } from "@caja/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Las vistas importan las server actions; aquí solo se renderizan (sin base ni sesión).
vi.mock("../app/admin/actions", () => ({
  approvePaymentAction: async () => null,
  cancelBatchAction: async () => null,
  changeTenantAction: async () => null,
  dismissRewardsAlertAction: async () => null,
  eraseTenantAction: async () => null,
  giftRechargeAction: async () => null,
  markFounderContactedAction: async () => null,
  recordPaymentAction: async () => null,
  rejectPaymentAction: async () => null,
  removePointsAction: async () => null,
  restoreTenantAction: async () => null,
  revealPhoneAction: async () => null,
  reversePaymentAction: async () => null,
  reviewRefMonthAction: async () => null,
  saveCrmAction: async () => null,
  saveHabitsAction: async () => null,
  saveLaunchAction: async () => null,
  saveRewardsAction: async () => null,
  saveSignupRescueAction: async () => null,
  scheduleBatchAction: async () => null,
  setFounderAction: async () => null,
  setReferralCodeAction: async () => null,
}));

const { RegistroView } = await import("../app/admin/views/registro");
const { NegocioView } = await import("../app/admin/views/negocio");

const OWNER = "584121234567";
const OTHER = "584241112267";
const now = new Date("2026-11-19T15:00:00Z");
/** Ninguna secuencia de 8 dígitos o más: el número completo no viaja en la página (A-2). Los ids
 * (UUID) de los enlaces pueden tener rachas de dígitos: se quitan antes de buscar. */
const NO_LONG_NUMBER = /\d{8,}/;
const UUIDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const withoutIds = (html: string) => html.replace(UUIDS, "");

describe("teléfonos del admin, sin el número completo en la página (A-2)", () => {
  it("Registro: enmascarado y «Escribirle» por el servidor", () => {
    const html = renderToStaticMarkup(
      <RegistroView
        banner={{ ok: null, error: null }}
        abandoned={[
          {
            id: "6f1c2a3b-4d5e-4f60-8a71-b2c3d4e5f607",
            e164: OWNER,
            name: "María",
            step: "accounts",
            kind: "business",
            messages: 3,
            updatedAt: now,
            rescueVia: null,
            rescueAt: null,
            contactOffAt: null,
            founderContactedAt: null,
          },
        ]}
        toContact={1}
        rescue={{
          windowSent: 0,
          windowFinished: 0,
          holdout: 0,
          holdoutFinished: 0,
          templateSent: 0,
          templateResume: 0,
          templateStop: 0,
          templateFinished: 0,
          purgeDeleted: 0,
          purgeKept: 0,
        }}
        lote={{
          schedule: null,
          ran: true,
          plan: null,
          nextWhen: "",
          scheduledWhen: null,
          inLeadWindow: false,
        }}
        now={now}
      />,
    );
    expect(withoutIds(html)).not.toMatch(NO_LONG_NUMBER);
    expect(html).not.toContain("wa.me");
    expect(html).toContain('href="/admin/escribir/signup/6f1c2a3b-4d5e-4f60-8a71-b2c3d4e5f607"');
    expect(html).toContain("+58 4•• ••• •• 67");
  });

  it("Ficha del negocio: «Escribirle por WhatsApp» del dueño y los números enmascarados", () => {
    const plan = PLANS.find((p) => p.id === "negocio");
    const tenantId = "7a2d3b4c-5e6f-4a70-9b81-c3d4e5f60718";
    const d = {
      referralCode: null,
      points: null,
      founderPct: 0,
      leyendaPct: 0,
      tenant: {
        id: tenantId,
        name: "Bodega",
        plan: "negocio",
        status: "trial",
        createdAt: now,
        signupChannel: "whatsapp",
        crmTags: [],
        crmNotes: null,
        founderUntil: null,
        survey: {},
        surveySentAt: null,
        valueSentAt: null,
        trialBudgetUsd: null,
        extraMonth: null,
        extraMessages: 0,
        deletedAt: null,
        deletionReason: null,
        purgeAfter: null,
      },
      plan,
      state: { kind: "trial", endsAt: now, daysLeft: 1 },
      phones: [
        {
          id: "8b3e4c5d-6f70-4b81-ac92-d4e5f6071829",
          e164: OWNER,
          role: "owner",
          status: "active",
          displayName: null,
          verifiedAt: now,
        },
        {
          id: "9c4f5d6e-7081-4c92-bd03-e5f60718293a",
          e164: OTHER,
          role: "employee",
          status: "active",
          displayName: null,
          verifiedAt: now,
        },
      ],
      usage: { inbound: 0, outbound: 0, aiTurns: 0, aiCostUsd: new Decimal(0), month: "2026-11" },
      trial: {
        budgetUsd: 1,
        spentUsd: 0,
        aiUsd: 0,
        metaUsd: 0,
        voiceUsd: 0,
        replies: 0,
        messages: 0,
        messageCap: 60,
        reached: false,
        byMessages: false,
      },
      payments: [],
      history: [],
    } as never;
    for (const tab of ["resumen", "numeros"] as const) {
      const html = renderToStaticMarkup(
        <NegocioView
          d={d}
          tab={tab}
          banner={{ ok: null, error: null }}
          health="green"
          launch={{ surveyDay: 10, valueDay: 25 }}
          suggested={{ pago_movil: "", zelle: "", binance: "" }}
          eurRate={false}
          actionId="x"
        />,
      );
      expect(withoutIds(html), tab).not.toMatch(NO_LONG_NUMBER);
      expect(html, tab).not.toContain("4121234567");
      expect(html, tab).toContain(
        `href="/admin/escribir/telefono/${tenantId}/8b3e4c5d-6f70-4b81-ac92-d4e5f6071829"`,
      );
    }
  });
});
