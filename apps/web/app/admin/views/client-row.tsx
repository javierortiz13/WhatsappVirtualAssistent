import { PLANS } from "@caja/core/plans";
import type { Health, TenantRow } from "@/lib/admin";
import { initials } from "../derive";
import { dueText, planClass, STATE, usd } from "../format";
import { Badge, Facts } from "../ui/bits";

/** Semáforo del CRM: cuándo escribió por última vez. */
export const HEALTH: Record<Health, { label: string; cls: string }> = {
  green: { label: "al día", cls: "ok" },
  amber: { label: "3+ días sin escribir", cls: "warn" },
  red: { label: "7+ días sin escribir", cls: "late" },
};

export const planName = (id: string) => PLANS.find((p) => p.id === id)?.name ?? id;

/** Un negocio en la lista: insignias arriba y cada dato en su línea (nada de frases con «·»). */
export function ClientRow({ t }: { t: TenantRow }) {
  const late =
    t.state.kind === "grace" || t.state.kind === "expired" || t.state.kind === "suspended";
  return (
    <a className="ad-cl" href={`/admin/negocios/${t.id}`}>
      <span className="ad-av" aria-hidden="true">
        {initials(t.name)}
      </span>
      <span className="ad-cl-body">
        <span className="ad-cl-name">{t.name}</span>
        <span className="ad-badges">
          <Badge tone={planClass(t.plan)}>{planName(t.plan)}</Badge>
          {t.purgeAfter ? (
            <Badge tone="late">papelera</Badge>
          ) : (
            <Badge tone={STATE[t.state.kind].cls}>{STATE[t.state.kind].label}</Badge>
          )}
          <Badge tone={HEALTH[t.health].cls}>
            <span className={`ad-dot ${HEALTH[t.health].cls}`} aria-hidden="true" />
            {HEALTH[t.health].label}
          </Badge>
          {t.founderUntil ? <Badge tone="ok">fundador</Badge> : null}
          {t.crmTags.map((tag) => (
            <Badge key={tag}>{tag}</Badge>
          ))}
        </span>
        <Facts
          rows={[
            [
              "Vence",
              <span key="v" className={late ? "ad-down" : ""}>
                {dueText(t.state)}
              </span>,
            ],
            [
              "Registros del mes",
              <span key="v" className={t.usage.inbound > t.cap ? "ad-down" : ""}>
                {t.usage.inbound} de {t.cap}
              </span>,
            ],
            [
              "Margen del mes",
              <span key="v" className={t.marginUsd.isNegative() ? "ad-down" : ""}>
                {usd(t.marginUsd)}
              </span>,
            ],
            ["IA y Meta", `${usd(t.usage.aiCostUsd)} y ${usd(t.metaCostUsd)}`],
            ["Alta por", t.signupChannel === "whatsapp" ? "WhatsApp" : "la web"],
            ...(t.pendingPayments
              ? ([
                  [
                    "Pagos por verificar",
                    <span key="v" className="ad-warn">
                      {t.pendingPayments}
                    </span>,
                  ],
                ] as [string, React.ReactNode][])
              : []),
          ]}
        />
      </span>
    </a>
  );
}
