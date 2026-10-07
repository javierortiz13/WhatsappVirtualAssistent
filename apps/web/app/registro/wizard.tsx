"use client";

import { useActionState, useMemo, useState } from "react";
import {
  ACCOUNT_TEMPLATES,
  type AccountTemplate,
  BUSINESS_TYPE_ICONS,
  categoryIcon,
  TILE_COLORS,
} from "@/lib/onboarding";
import { COUNTRY_CODES } from "@/lib/phone";
import { registerWizardAction, type WizardState } from "./actions";

export type PlanView = {
  id: "personal" | "negocio" | "negocio_plus";
  name: string;
  priceUsd: number;
  tagline: string;
  features: string[];
};

type Props = {
  plans: PlanView[];
  businessTypes: { id: string; label: string }[];
  /** Categorías por defecto de cada tipo (incluye "personal"). */
  defaults: Record<string, readonly string[]>;
  suggestions: readonly string[];
  maxCategories: number;
  maxAccounts: number;
  pilotNote: string;
  /** Beta (07/10): sin precios, "14 días gratis". */
  beta?: boolean;
};

type AccountDraft = { template: string; name: string; opening: string };

const STEPS = ["Plan", "Perfil", "Categorías", "Cuentas", "WhatsApp"] as const;
const OTHERS = "Otros";

const PLAN_ICON: Record<PlanView["id"], string> = {
  personal: "🙋",
  negocio: "🏪",
  negocio_plus: "🏢",
};

/**
 * Onboarding paso a paso (05/10/2026, como Rial): plan, perfil, categorías, cuentas y número.
 * Todo vive aquí hasta el último paso; el servidor crea la cuenta de una vez y pasa al código de
 * WhatsApp. Un error del servidor vuelve al paso que toca sin perder lo escrito.
 */
export function RegistroWizard(props: Props) {
  const [step, setStep] = useState(0);
  const [plan, setPlan] = useState<PlanView["id"]>("negocio");
  const personal = plan === "personal";
  const [name, setName] = useState("");
  const [businessType, setBusinessType] = useState("car_wash");
  const [currency, setCurrency] = useState<"USD" | "VES">("USD");
  const [ownerName, setOwnerName] = useState("");
  const typeKey = personal ? "personal" : businessType;
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const categories = picked[typeKey] ?? [...(props.defaults[typeKey] ?? [])];
  const [custom, setCustom] = useState("");
  const [accounts, setAccounts] = useState<AccountDraft[]>([]);
  const [country, setCountry] = useState("58");
  const [phone, setPhone] = useState("");
  const [state, action, pending] = useActionState<WizardState, FormData>(
    async (prev, fd) => {
      const r = await registerWizardAction(prev, fd);
      if (r.step !== undefined) setStep(r.step);
      return r;
    },
    { error: null },
  );

  const setCategories = (list: string[]) => setPicked((p) => ({ ...p, [typeKey]: list }));
  const active = categories.filter((c) => c !== OTHERS);
  const full = active.length >= props.maxCategories - 1;
  const toggle = (c: string) =>
    setCategories(
      categories.includes(c)
        ? categories.filter((x) => x !== c)
        : full
          ? categories
          : [...active, c, OTHERS],
    );
  const pool = useMemo(() => {
    const base = [...(props.defaults[typeKey] ?? []), ...props.suggestions];
    const extra = categories.filter((c) => !base.includes(c));
    return [...new Set([...base, ...extra])].filter((c) => c !== OTHERS);
  }, [props.defaults, props.suggestions, typeKey, categories]);
  const addCustom = () => {
    const c = custom.replace(/\s+/g, " ").trim().slice(0, 24);
    if (!c || full) return;
    if (!categories.some((x) => x.toLowerCase() === c.toLowerCase()))
      setCategories([...active, c, OTHERS]);
    setCustom("");
  };

  const addAccount = (t: AccountTemplate) => {
    if (accounts.length >= props.maxAccounts || accounts.some((a) => a.template === t.id)) return;
    setAccounts([...accounts, { template: t.id, name: t.name, opening: "" }]);
  };
  const updateAccount = (i: number, patch: Partial<AccountDraft>) =>
    setAccounts(accounts.map((a, j) => (j === i ? { ...a, ...patch } : a)));

  const canNext =
    step === 0 ||
    (step === 1 && name.trim().length >= 2) ||
    step === 2 ||
    step === 3 ||
    (step === 4 && phone.replace(/\D/g, "").length >= 7);

  const payload = JSON.stringify({
    plan,
    name: name.trim(),
    business_type: typeKey,
    currency,
    categories,
    accounts: accounts.map((a) => {
      const t = ACCOUNT_TEMPLATES.find((x) => x.id === a.template) as AccountTemplate;
      return {
        name: a.name.trim() || t.name,
        currency: t.currency,
        kind: t.kind,
        opening: a.opening,
      };
    }),
    country,
    phone,
    owner_name: personal ? name.trim() : ownerName.trim(),
  });

  return (
    <main className="wizard">
      <header className="wizard-top">
        <button
          type="button"
          className="iconbtn"
          aria-label="Atrás"
          onClick={() => (step === 0 ? window.history.back() : setStep(step - 1))}
        >
          ‹
        </button>
        <ol className="progress" aria-label={`Paso ${step + 1} de ${STEPS.length + 1}`}>
          {[...STEPS, "Código"].map((s, i) => (
            <li key={s} className={`progress-seg ${i <= step ? "done" : ""}`} />
          ))}
        </ol>
      </header>

      <section className="wizard-body">
        {step === 0 ? (
          <>
            <h1>¿Cómo lo vas a usar?</h1>
            <p className="lead">Elige tu plan. Puedes cambiarlo cuando quieras.</p>
            <div className="choice-list">
              {props.plans.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  className={`choice plan-${p.id} ${plan === p.id ? "on" : ""}`}
                  onClick={() => setPlan(p.id)}
                  aria-pressed={plan === p.id}
                >
                  <span className="choice-icon">{PLAN_ICON[p.id]}</span>
                  <span className="choice-text">
                    <strong className="choice-title">
                      {p.name}
                      <span className="price">
                        {props.beta
                          ? "14 días gratis"
                          : `$${p.priceUsd.toFixed(2).replace(".", ",")}/mes`}
                      </span>
                    </strong>
                    <span>{p.tagline}</span>
                    {plan === p.id ? (
                      <ul className="choice-features">
                        {p.features.slice(0, 4).map((f) => (
                          <li key={f}>{f}</li>
                        ))}
                      </ul>
                    ) : null}
                  </span>
                  <span className="check" aria-hidden="true" />
                </button>
              ))}
            </div>
            <p className="pilot">🎁 {props.pilotNote}</p>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <h1>{personal ? "Cuéntanos de ti" : "Tu negocio"}</h1>
            <p className="lead">
              {personal
                ? "Así te saluda Rocco y sabe en qué moneda hablas."
                : "Con esto preparamos tus categorías y tus cierres."}
            </p>
            <div className="panel stack">
              <label className="field">
                <span>{personal ? "Tu nombre" : "Nombre del negocio"}</span>
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                  placeholder={personal ? "Javier" : "Autolavado El Rápido"}
                  autoComplete={personal ? "given-name" : "organization"}
                />
              </label>
              {!personal ? (
                <>
                  <span className="field-label">¿Qué tipo de negocio es?</span>
                  <div className="tiles">
                    {props.businessTypes.map((b) => (
                      <button
                        type="button"
                        key={b.id}
                        className={`tile-btn ${businessType === b.id ? "on" : ""}`}
                        onClick={() => setBusinessType(b.id)}
                        aria-pressed={businessType === b.id}
                      >
                        <span className="tile-emoji">{BUSINESS_TYPE_ICONS[b.id] ?? "💼"}</span>
                        {b.label}
                      </button>
                    ))}
                  </div>
                  <label className="field">
                    <span>Tu nombre (opcional)</span>
                    <input
                      className="input"
                      value={ownerName}
                      onChange={(e) => setOwnerName(e.target.value)}
                      maxLength={60}
                      autoComplete="name"
                    />
                  </label>
                </>
              ) : null}
              <span className="field-label">
                ¿En qué moneda hablas de {personal ? "tus gastos" : "los gastos"}?
              </span>
              <div className="tiles two">
                {(
                  [
                    ["USD", "💵", "Dólares", "gasté 20 = $20"],
                    ["VES", "🇻🇪", "Bolívares", "gasté 20 mil = Bs 20.000"],
                  ] as const
                ).map(([c, icon, label, hint]) => (
                  <button
                    type="button"
                    key={c}
                    className={`tile-btn ${currency === c ? "on" : ""}`}
                    onClick={() => setCurrency(c)}
                    aria-pressed={currency === c}
                  >
                    <span className="tile-emoji">{icon}</span>
                    {label}
                    <small>{hint}</small>
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <h1>Elige tus categorías</h1>
            <p className="lead">
              El asistente clasifica cada gasto en una de estas. Podrás cambiarlas después.
            </p>
            <div className="count-row">
              <span>Hasta {props.maxCategories}, con Otros incluida</span>
              <strong className="count-num">
                {categories.length} de {props.maxCategories}
              </strong>
            </div>
            <div className="cat-list">
              {active.map((c, i) => (
                <button
                  type="button"
                  key={c}
                  className="ocat on"
                  onClick={() => toggle(c)}
                  aria-pressed="true"
                  aria-label={`Quitar ${c}`}
                >
                  <span
                    className="ocat-icon"
                    style={{ background: `${TILE_COLORS[i % TILE_COLORS.length]}26` }}
                  >
                    {categoryIcon(c)}
                  </span>
                  <span className="ocat-name">{c}</span>
                  <span className="check" aria-hidden="true" />
                </button>
              ))}
              <div className="ocat on locked">
                <span className="ocat-icon" style={{ background: "rgba(255,255,255,0.08)" }}>
                  📌
                </span>
                <span className="ocat-name">
                  Otros <small>siempre está</small>
                </span>
                <span className="check" aria-hidden="true" />
              </div>
            </div>
            {pool.some((c) => !categories.includes(c)) ? (
              <>
                <span className="field-label">Más ideas</span>
                <div className="idea-chips">
                  {pool
                    .filter((c) => !categories.includes(c))
                    .map((c) => (
                      <button
                        type="button"
                        key={c}
                        className="idea-chip"
                        onClick={() => toggle(c)}
                        disabled={full}
                      >
                        + {categoryIcon(c)} {c}
                      </button>
                    ))}
                </div>
              </>
            ) : null}
            <div className="add-row">
              <input
                className="input"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustom();
                  }
                }}
                maxLength={24}
                placeholder={full ? "Ya tienes 10: quita una para agregar" : "Agregar una propia"}
                disabled={full}
              />
              <button
                type="button"
                className="btn secondary"
                onClick={addCustom}
                disabled={full || !custom.trim()}
              >
                Agregar
              </button>
            </div>
          </>
        ) : null}

        {step === 3 ? (
          <>
            <h1>¿Dónde tienes tu dinero?</h1>
            <p className="lead">
              Crea tus cuentas y Rocco te dice cuánto queda en cada una. Puedes saltar este paso.
            </p>
            <div className="tiles">
              {ACCOUNT_TEMPLATES.map((t) => {
                const on = accounts.some((a) => a.template === t.id);
                return (
                  <button
                    type="button"
                    key={t.id}
                    className={`tile-btn ${on ? "on" : ""}`}
                    onClick={() =>
                      on ? setAccounts(accounts.filter((a) => a.template !== t.id)) : addAccount(t)
                    }
                    disabled={!on && accounts.length >= props.maxAccounts}
                    aria-pressed={on}
                  >
                    <span className="tile-emoji">{t.icon}</span>
                    {t.label}
                    <small>{t.hint}</small>
                  </button>
                );
              })}
            </div>
            {accounts.length ? (
              <div className="panel stack">
                {accounts.map((a, i) => {
                  const t = ACCOUNT_TEMPLATES.find((x) => x.id === a.template) as AccountTemplate;
                  return (
                    <div className="account-edit" key={a.template}>
                      <span className="tile-emoji">{t.icon}</span>
                      <label className="field">
                        <span>Nombre</span>
                        <input
                          className="input"
                          value={a.name}
                          maxLength={40}
                          onChange={(e) => updateAccount(i, { name: e.target.value })}
                          placeholder={
                            t.currency === "VES" && t.kind === "bank" ? "Banesco" : t.name
                          }
                        />
                      </label>
                      <label className="field">
                        <span>Tienes hoy ({t.unit})</span>
                        <input
                          className="input"
                          value={a.opening}
                          inputMode="decimal"
                          onChange={(e) => updateAccount(i, { opening: e.target.value })}
                          placeholder="0"
                        />
                      </label>
                    </div>
                  );
                })}
                <p className="sub" style={{ margin: 0 }}>
                  Hasta {props.maxAccounts} ahora; más desde Ajustes → Cuentas. Los Bs que ya tienes
                  quedan valorados a la BCV de hoy.
                </p>
              </div>
            ) : null}
          </>
        ) : null}

        {step === 4 ? (
          <>
            <h1>Tu WhatsApp</h1>
            <p className="lead">
              El número desde el que le vas a escribir a Rocco. En el siguiente paso lo confirmas
              con un código.
            </p>
            <div className="panel stack">
              <div className="phone-row">
                <select
                  className="input"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  aria-label="País"
                >
                  {COUNTRY_CODES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <input
                  className="input"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  inputMode="tel"
                  autoComplete="tel-national"
                  placeholder="412 1234567"
                />
              </div>
              <div className="recap">
                <span className="recap-icon">{PLAN_ICON[plan]}</span>
                <p className="recap-text">
                  <strong>{name.trim() || "Tu cuenta"}</strong>
                  <br />
                  Plan {props.plans.find((p) => p.id === plan)?.name} · {categories.length}{" "}
                  categorías · {accounts.length === 1 ? "1 cuenta" : `${accounts.length} cuentas`}
                </p>
              </div>
            </div>
          </>
        ) : null}

        {state.error ? <div className="notice err">{state.error}</div> : null}
      </section>

      <footer className="wizard-foot">
        <span className="sub">
          Paso {step + 1} de {STEPS.length + 1}
          {step === 3 && accounts.length === 0 ? " · puedes saltarlo" : ""}
        </span>
        {step < STEPS.length - 1 ? (
          <button
            type="button"
            className="fab"
            onClick={() => setStep(step + 1)}
            disabled={!canNext}
            aria-label="Siguiente"
          >
            ›
          </button>
        ) : (
          <form action={action}>
            <input type="hidden" name="payload" value={payload} />
            <button
              type="submit"
              className="fab wide"
              disabled={!canNext || pending}
              aria-label="Crear mi cuenta"
            >
              {pending ? "Creando…" : "Crear mi cuenta ›"}
            </button>
          </form>
        )}
      </footer>
    </main>
  );
}
