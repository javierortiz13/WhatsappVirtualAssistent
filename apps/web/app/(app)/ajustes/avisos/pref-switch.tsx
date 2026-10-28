"use client";

import { useId, useRef } from "react";
import { setPrefAction } from "./actions";

/**
 * Un interruptor de Ajustes (US-205, H14). Encender guarda al instante; apagar abre el diálogo
 * H14e ("Apagar" / "Cancelar"). El diálogo nativo atrapa el foco y Esc lo cancela.
 */
export function PrefSwitch(p: {
  which: "nudge" | "unsolicited";
  on: boolean;
  label: string;
  help: string;
  disabled: boolean;
  confirmTitle: string;
  confirmBody: string;
  confirm: string;
  cancel: string;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  return (
    <div className="pref-switch">
      <form action={setPrefAction} className="pref-row">
        <input type="hidden" name="which" value={p.which} />
        <input type="hidden" name="on" value="1" />
        <span className="what">
          <strong id={`${id}-label`}>{p.label}</strong>
          <span className="sub" id={`${id}-help`}>
            {p.help}
          </span>
        </span>
        <button
          className={`switch${p.on ? " on" : ""}`}
          type={p.on ? "button" : "submit"}
          role="switch"
          aria-checked={p.on}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-help`}
          aria-disabled={p.disabled || undefined}
          onClick={(e) => {
            if (p.disabled) {
              e.preventDefault();
              return;
            }
            if (p.on) {
              dialog.current?.showModal();
              // El foco empieza en el título (copy H14e, accesibilidad).
              title.current?.focus();
            }
          }}
        >
          <span className="knob" aria-hidden="true" />
        </button>
      </form>
      <dialog
        ref={dialog}
        className="pref-dialog"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
      >
        <form action={setPrefAction} className="stack-sm">
          <input type="hidden" name="which" value={p.which} />
          <input type="hidden" name="on" value="0" />
          <h2 id={`${id}-title`} tabIndex={-1} ref={title}>
            {p.confirmTitle}
          </h2>
          <p id={`${id}-body`}>{p.confirmBody}</p>
          <div className="pref-dialog-actions">
            <button className="btn" type="submit">
              {p.confirm}
            </button>
            <button className="btn secondary" type="button" onClick={() => dialog.current?.close()}>
              {p.cancel}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}
