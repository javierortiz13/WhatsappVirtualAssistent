"use client";

import { useEffect } from "react";

/**
 * Efectos de scroll sin librería: marca `.in` en cada `.reveal` cuando entra en pantalla (respaldo
 * para navegadores sin `animation-timeline`) y arranca la conversación del teléfono al verlo.
 * No hace nada si el usuario pidió menos movimiento.
 */
export function Effects() {
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const reveals = document.querySelectorAll<HTMLElement>(".reveal");
    const phone = document.querySelector<HTMLElement>(".phone");
    if (reduce) {
      for (const el of reveals) el.classList.add("in");
      phone?.classList.add("play");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add(e.target.classList.contains("phone") ? "play" : "in");
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.15 },
    );
    for (const el of reveals) io.observe(el);
    if (phone) io.observe(phone);
    return () => io.disconnect();
  }, []);
  return null;
}
