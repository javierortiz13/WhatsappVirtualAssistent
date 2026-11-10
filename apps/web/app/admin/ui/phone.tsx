"use client";

import { useState } from "react";
import { formatE164, maskE164 } from "@/lib/phone";

/**
 * Teléfono enmascarado («+58 4•• ••• •• 67») con «Ver» para mostrarlo completo (rediseño 08/11).
 * Para que no quede a la vista de quien mira la pantalla; «Escribirle» sigue abriendo wa.me.
 */
export function MaskedPhone({ e164 }: { e164: string }) {
  const [shown, setShown] = useState(false);
  return (
    <span>
      <span className="ad-phone">{shown ? formatE164(e164) : maskE164(e164)}</span>{" "}
      <button
        type="button"
        className="ad-link"
        aria-pressed={shown}
        onClick={() => setShown((v) => !v)}
      >
        {shown ? "Ocultar" : "Ver"}
      </button>
    </span>
  );
}
