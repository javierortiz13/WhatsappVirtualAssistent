import {
  type AdminFlagKey,
  APPROVALS,
  dependentsOn,
  FLAG_RULES,
  type FlagGroup,
  type FlagState,
  missingNeeds,
  ruleOf,
} from "@caja/core/admin-flags";
import type { AbandonedSignup, TenantRow } from "@/lib/admin";
import type { FlagView } from "./ui/flag-group";

/** Lógica pura de /admin (rediseño 08/11): la usan las secciones y las capturas. */

/** Nombre del campo de cada interruptor en el formulario de su grupo (el de siempre). */
export const FIELD: Record<AdminFlagKey, string> = {
  streakLine: "streak_line",
  noSpend: "no_spend",
  prefs: "prefs",
  nudge: "nudge",
  dailyClose: "daily_close",
  reminders: "reminders",
  xp: "xp",
  rewards: "rewards",
  referrals: "referrals",
  inWindow: "in_window",
  template: "template",
  viaTemplate: "via_template",
};

/** Los interruptores de un grupo como los dibuja la hoja, con las reglas de core. */
export function flagViews(group: FlagGroup, state: FlagState): FlagView[] {
  return FLAG_RULES.filter((r) => r.group === group).map((r) => {
    const on = state[r.key];
    const missing = missingNeeds(r.key, state).map((k) => ruleOf(k).title);
    const lock = on
      ? null
      : r.blocked
        ? r.blocked
        : r.managed
          ? r.managed
          : missing.length
            ? `Necesita ${missing.join(" y ")}`
            : null;
    const appr = r.approval ? APPROVALS[r.approval] : null;
    return {
      field: FIELD[r.key],
      title: r.title,
      desc: r.desc,
      on,
      lock,
      fixed: Boolean(r.sticky && on),
      needs: (r.needs ?? []).map((k) => ruleOf(k).title),
      approval:
        r.approval && appr
          ? {
              code: r.approval,
              approved: appr.status === "approved",
              ...("target" in appr ? { target: String(appr.target) } : {}),
            }
          : null,
      cascade: dependentsOn(r.key, state).map((k) => ({ field: FIELD[k], title: ruleOf(k).title })),
    };
  });
}

/** Registros sin terminar a los que todavía se les puede escribir (ni Rocco ni tú, ni control). */
export function toContact(list: AbandonedSignup[]): AbandonedSignup[] {
  return list.filter(
    (a) =>
      !a.founderContactedAt &&
      !a.contactOffAt &&
      a.rescueVia !== "window" &&
      a.rescueVia !== "template" &&
      a.rescueVia !== "holdout",
  );
}

// ---------------------------------------------------------------- Clientes: filtros en la URL

export const STATE_FILTERS = ["trial", "active", "grace", "expired", "suspended"] as const;
export type StateFilter = (typeof STATE_FILTERS)[number];
export const SORTS = ["vence", "ultimo", "margen", "tope"] as const;
export type Sort = (typeof SORTS)[number];

export type ClientFilters = {
  q: string;
  plan: "todos" | "personal" | "negocio" | "negocio_plus";
  estados: StateFilter[];
  ultimo: "todos" | "green" | "amber" | "red";
  orden: Sort;
  internas: boolean;
};

/** Lee los filtros de ?q=&plan=&estado=&ultimo=&orden=&internas=1 (lo desconocido se ignora). */
export function parseFilters(sp: Record<string, string | string[] | undefined>): ClientFilters {
  const one = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v) ?? "";
  };
  const estados = (Array.isArray(sp.estado) ? sp.estado : (sp.estado ?? "").split(","))
    .flatMap((s) => s.split(","))
    .filter((s): s is StateFilter => (STATE_FILTERS as readonly string[]).includes(s));
  const plan = one("plan");
  const ultimo = one("ultimo");
  const orden = one("orden");
  return {
    q: one("q").trim().slice(0, 80),
    plan: plan === "personal" || plan === "negocio" || plan === "negocio_plus" ? plan : "todos",
    estados: [...new Set(estados)],
    ultimo: ultimo === "green" || ultimo === "amber" || ultimo === "red" ? ultimo : "todos",
    orden: (SORTS as readonly string[]).includes(orden) ? (orden as Sort) : "vence",
    internas: one("internas") === "1",
  };
}

/** La URL de Clientes con un filtro cambiado (los chips son enlaces). */
export function filtersHref(f: ClientFilters, change: Partial<ClientFilters>): string {
  const n = { ...f, ...change };
  const p = new URLSearchParams();
  if (n.q) p.set("q", n.q);
  if (n.plan !== "todos") p.set("plan", n.plan);
  if (n.estados.length) p.set("estado", n.estados.join(","));
  if (n.ultimo !== "todos") p.set("ultimo", n.ultimo);
  if (n.orden !== "vence") p.set("orden", n.orden);
  if (n.internas) p.set("internas", "1");
  const s = p.toString();
  return s ? `/admin/clientes?${s}` : "/admin/clientes";
}

/** Sin acentos ni mayúsculas, para buscar por nombre. */
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Lo que se busca: el estado de un negocio en la papelera cuenta como «suspendido». */
export const stateOf = (t: TenantRow): StateFilter =>
  t.purgeAfter ? "suspended" : (t.state.kind as StateFilter);

export function filterClients(list: TenantRow[], f: ClientFilters): TenantRow[] {
  const q = fold(f.q);
  const out = list.filter(
    (t) =>
      (f.internas || !t.internal) &&
      (!q || fold(t.name).includes(q)) &&
      (f.plan === "todos" || t.plan === f.plan) &&
      (!f.estados.length || f.estados.includes(stateOf(t))) &&
      (f.ultimo === "todos" || t.health === f.ultimo),
  );
  const days = (t: TenantRow) => t.state.daysLeft ?? Number.POSITIVE_INFINITY;
  const silent = (t: TenantRow) =>
    t.lastInboundAt ? -t.lastInboundAt.getTime() : Number.NEGATIVE_INFINITY;
  const use = (t: TenantRow) => (t.cap ? t.usage.inbound / t.cap : 0);
  const by: Record<Sort, (a: TenantRow, b: TenantRow) => number> = {
    vence: (a, b) => days(a) - days(b),
    ultimo: (a, b) => silent(a) - silent(b),
    margen: (a, b) => a.marginUsd.comparedTo(b.marginUsd),
    tope: (a, b) => use(b) - use(a),
  };
  return [...out].sort((a, b) => by[f.orden](a, b) || a.name.localeCompare(b.name, "es"));
}

/** Cuántos hay en cada estado con el resto de filtros (para el conteo de cada chip). */
export function stateCounts(list: TenantRow[], f: ClientFilters): Record<StateFilter, number> {
  const base = filterClients(list, { ...f, estados: [] });
  return Object.fromEntries(
    STATE_FILTERS.map((s) => [s, base.filter((t) => stateOf(t) === s).length]),
  ) as Record<StateFilter, number>;
}

/** «Clientes que necesitan atención»: vencen pronto, ya vencieron, pasaron el tope o no escriben. */
export function needsAttention(list: TenantRow[]): TenantRow[] {
  return list
    .filter(
      (t) =>
        !t.internal &&
        !t.purgeAfter &&
        (t.usage.inbound > t.cap ||
          t.state.kind === "grace" ||
          t.state.kind === "expired" ||
          (t.state.daysLeft !== null && t.state.daysLeft <= 3) ||
          t.health !== "green"),
    )
    .sort((a, b) => {
      const w = (t: TenantRow) =>
        (t.usage.inbound > t.cap ? 0 : 10) +
        (t.state.kind === "grace" || t.state.kind === "expired" ? 0 : 5) +
        (t.health === "red" ? 0 : t.health === "amber" ? 2 : 4);
      return w(a) - w(b);
    })
    .slice(0, 5);
}

/** Iniciales para el cuadrito del cliente («Bodega La Esquina» → «BL»). */
export function initials(name: string): string {
  return (
    name
      .split(/[\s.·]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "?"
  );
}
