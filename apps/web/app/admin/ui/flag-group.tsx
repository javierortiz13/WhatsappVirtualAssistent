"use client";

import { useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";

/** Un interruptor ya calculado en el servidor con las reglas de `@caja/core/admin-flags`. */
export type FlagView = {
  /** Nombre del campo en el formulario de su grupo («daily_close»). */
  field: string;
  title: string;
  desc: string;
  on: boolean;
  /** No se puede tocar, y por qué (🔒 «Necesita …», «No aprobado», «Lo controla el lote»). */
  lock: string | null;
  /** «no se apaga» (Avisos encendido). */
  fixed: boolean;
  /** Lo que necesita encendido, para la hoja al encender. */
  needs: string[];
  approval: { code: string; approved: boolean; target?: string } | null;
  /** Encendidos que se apagan con él (campo y título). */
  cascade: { field: string; title: string }[];
};

/**
 * Un grupo de interruptores que se guarda con la misma server action de siempre (hábito, puntos o
 * registro). Se acaba el «Guardar» general: cada interruptor abre una hoja «¿Encender X?» o
 * «¿Apagar X?» y se guarda solo al confirmar, con el resto de valores iguales. Para encender uno
 * con aprobación de la agencia hay que escribir su código exacto; apagar nunca lo pide. El
 * servidor vuelve a validar todo.
 */
export function FlagGroup({
  action,
  flags,
  hidden = {},
  open,
}: {
  action: (formData: FormData) => Promise<void>;
  flags: FlagView[];
  /** Otros campos del formulario que van iguales (el tope de regalos, «from»). */
  hidden?: Record<string, string> | undefined;
  /** Solo para las capturas: la hoja de un campo abierta. */
  open?: { field: string; code?: string | undefined } | undefined;
}) {
  const form = useRef<HTMLFormElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState<FlagView | null>(
    open ? (flags.find((f) => f.field === open.field) ?? null) : null,
  );
  const [code, setCode] = useState(open?.code ?? "");
  const [values, setValues] = useState(() => Object.fromEntries(flags.map((f) => [f.field, f.on])));
  const titleId = useId();
  const codeId = useId();
  useEffect(() => {
    if (open && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [open]);

  const ask = (f: FlagView) => {
    setPending(f);
    setCode("");
    dialog.current?.showModal();
  };
  const turningOn = pending ? !pending.on : false;
  const needsCode = Boolean(turningOn && pending?.approval);
  const blocked =
    turningOn && pending?.approval
      ? !pending.approval.approved || code.trim() !== pending.approval.code
      : false;

  const confirm = () => {
    if (!pending || blocked) return;
    const next = { ...values, [pending.field]: turningOn };
    if (!turningOn) for (const c of pending.cascade) next[c.field] = false;
    // Los valores nuevos tienen que estar en el DOM antes de enviar.
    flushSync(() => setValues(next));
    dialog.current?.close();
    form.current?.requestSubmit();
  };

  return (
    <form action={action} ref={form}>
      {Object.entries(hidden).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      {Object.entries(values).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v ? "on" : ""} />
      ))}
      <input type="hidden" name="approval_code" value={needsCode ? code.trim() : ""} />
      <div>
        {flags.map((f) => {
          const descId = `${f.field}-d`;
          return (
            <div className="ad-sw-row" key={f.field}>
              <span className="ad-sw-t" id={`${f.field}-t`}>
                {f.title}
              </span>
              <button
                type="button"
                role="switch"
                className="ad-switch"
                aria-checked={f.on}
                aria-labelledby={`${f.field}-t`}
                aria-describedby={descId}
                disabled={Boolean(f.lock) || f.fixed}
                onClick={() => ask(f)}
              >
                <span className="track" />
                <span className="knob" />
              </button>
              <span className="ad-sw-d" id={descId}>
                {f.desc}
              </span>
              {f.approval || f.lock || f.fixed ? (
                <span className="ad-sw-req">
                  {f.approval ? (
                    <span className={`ad-b ${f.approval.approved ? "ok" : "warn"}`}>
                      {f.approval.code} ·{" "}
                      {f.approval.approved
                        ? "aprobado"
                        : `pendiente${f.approval.target ? ` (${f.approval.target})` : ""}`}
                    </span>
                  ) : null}
                  {f.lock ? <span className="ad-lock">🔒 {f.lock}</span> : null}
                  {f.fixed ? <span className="ad-b">no se apaga</span> : null}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      <dialog
        ref={dialog}
        className="ad-sheet"
        aria-labelledby={titleId}
        open={open ? true : undefined}
      >
        {pending ? (
          <>
            <h3 id={titleId}>
              {turningOn ? "¿Encender" : "¿Apagar"} {pending.title}?
            </h3>
            {turningOn ? (
              <>
                {pending.needs.length || pending.approval ? (
                  <ul className="ad-checks">
                    {pending.needs.map((n) => (
                      <li key={n}>
                        <span className="ad-ck y" aria-hidden="true">
                          ✓
                        </span>
                        <span>{n} encendido</span>
                      </li>
                    ))}
                    {pending.approval ? (
                      <li>
                        <span
                          className={`ad-ck ${pending.approval.approved ? "y" : "n"}`}
                          aria-hidden="true"
                        >
                          {pending.approval.approved ? "✓" : "✕"}
                        </span>
                        <span>
                          Aprobación {pending.approval.code}{" "}
                          {pending.approval.approved
                            ? "de la agencia"
                            : `pendiente${pending.approval.target ? ` (${pending.approval.target})` : ""}`}
                        </span>
                      </li>
                    ) : null}
                  </ul>
                ) : null}
                {pending.approval?.approved ? (
                  <label className="ad-field" htmlFor={codeId}>
                    Escribe el código de la aprobación ({pending.approval.code})
                    <input
                      id={codeId}
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      autoComplete="off"
                      autoCapitalize="characters"
                      spellCheck={false}
                    />
                  </label>
                ) : null}
                {pending.approval && !pending.approval.approved ? (
                  <p className="ad-note ad-warn">
                    No se puede encender mientras la aprobación esté pendiente.
                  </p>
                ) : null}
                <p className="ad-note">Aplica para todos los clientes desde el próximo mensaje.</p>
              </>
            ) : (
              <p className="ad-note">
                Rocco deja de usarlo desde el próximo mensaje.
                {pending.cascade.length
                  ? ` También se apaga: ${pending.cascade.map((c) => c.title).join(", ")}.`
                  : ""}
              </p>
            )}
            <div className="ad-btns">
              <button
                type="button"
                className="ad-btn"
                // biome-ignore lint/a11y/noAutofocus: el foco empieza en «Cancelar», lo seguro.
                autoFocus
                onClick={() => dialog.current?.close()}
              >
                Cancelar
              </button>
              <button
                type="button"
                className={`ad-btn ${turningOn ? "pri" : "dan"}`}
                disabled={blocked}
                onClick={confirm}
              >
                {turningOn ? "Encender" : "Apagar"}
              </button>
            </div>
          </>
        ) : null}
      </dialog>
    </form>
  );
}
