"use client";

import { type ReactNode, useEffect, useId, useRef } from "react";

/**
 * Botón que, en vez de enviar su formulario al tocarlo, abre una hoja de confirmación (rediseño
 * 08/11): «¿Aprobar el pago de …?» con «Cancelar» y la acción. Al confirmar envía el formulario
 * en el que está, con su `name`/`value` como si se hubiera tocado. Sin JavaScript no envía nada.
 */
export function ConfirmButton({
  label,
  title,
  body,
  ok = "Confirmar",
  danger = false,
  className = "ad-btn",
  name,
  value,
  disabled = false,
  defaultOpen = false,
}: {
  label: ReactNode;
  title: string;
  body?: ReactNode;
  ok?: string;
  danger?: boolean;
  className?: string;
  name?: string;
  value?: string;
  disabled?: boolean;
  /** Solo para las capturas: la hoja abierta. */
  defaultOpen?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submit = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (defaultOpen && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [defaultOpen]);
  return (
    <>
      <button
        type="button"
        className={className}
        disabled={disabled}
        onClick={() => dialog.current?.showModal()}
      >
        {label}
      </button>
      <button ref={submit} type="submit" name={name} value={value} hidden tabIndex={-1} />
      <dialog
        ref={dialog}
        className="ad-sheet"
        aria-labelledby={titleId}
        open={defaultOpen ? true : undefined}
      >
        <h3 id={titleId}>{title}</h3>
        {body}
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
            className={`ad-btn ${danger ? "dan" : "pri"}`}
            onClick={() => {
              dialog.current?.close();
              const form = submit.current?.form;
              if (form && submit.current) form.requestSubmit(submit.current);
            }}
          >
            {ok}
          </button>
        </div>
      </dialog>
    </>
  );
}
