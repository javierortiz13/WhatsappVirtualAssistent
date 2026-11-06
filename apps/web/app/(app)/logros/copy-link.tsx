"use client";

import { useState } from "react";

/** «Copiar enlace» (RW5-5): copia el enlace para invitar y avisa «Enlace copiado». */
export function CopyLink({ value, label, done }: { value: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <button
        className="btn small secondary"
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {label}
      </button>
      <span className="sub" role="status" aria-live="polite">
        {copied ? done : ""}
      </span>
    </>
  );
}
