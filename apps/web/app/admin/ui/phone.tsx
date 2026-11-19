"use client";

import { useState, useTransition } from "react";
import type { PhoneRef } from "@/lib/phone";
import { revealPhoneAction } from "../actions";

/**
 * Teléfono enmascarado («+58 4•• ••• •• 67») con «Ver» (rediseño 08/11). Desde A-2 (19/11) el
 * número completo no viaja en la página: «Ver» se lo pide al servidor, que comprueba el admin.
 */
export function MaskedPhone({ masked, phoneRef }: { masked: string; phoneRef: PhoneRef }) {
  const [full, setFull] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [pending, start] = useTransition();
  const toggle = () => {
    if (shown) return setShown(false);
    if (full) return setShown(true);
    start(async () => {
      const n = await revealPhoneAction(phoneRef);
      if (n) {
        setFull(n);
        setShown(true);
      }
    });
  };
  return (
    <span>
      <span className="ad-phone">{shown && full ? full : masked}</span>{" "}
      <button
        type="button"
        className="ad-link"
        aria-pressed={shown}
        disabled={pending}
        onClick={toggle}
      >
        {shown ? "Ocultar" : pending ? "…" : "Ver"}
      </button>
    </span>
  );
}
