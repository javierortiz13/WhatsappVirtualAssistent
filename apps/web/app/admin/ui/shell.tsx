"use client";

import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useRef } from "react";

/** Secciones de /admin (rediseño 08/11). `count` sale en ámbar si hay algo pendiente. */
export const NAV = [
  { href: "/admin", label: "Resumen", icon: "◎" },
  { href: "/admin/clientes", label: "Clientes", icon: "☰" },
  { href: "/admin/pagos", label: "Pagos", icon: "$", countKey: "pagos" },
  { href: "/admin/habito", label: "Hábito", icon: "↻" },
  { href: "/admin/puntos", label: "Puntos e invitaciones", icon: "★" },
  { href: "/admin/registro", label: "Registro", icon: "✎", countKey: "registro" },
  { href: "/admin/interruptores", label: "Interruptores", icon: "⏻" },
  { href: "/admin/cobro", label: "Cobro y tasas", icon: "Bs" },
] as const;

export type NavCounts = { pagos: number; registro: number };

/** La sección de una ruta: /admin/negocios/… cuenta como Clientes. */
export function sectionOf(path: string): string {
  if (path.startsWith("/admin/negocios")) return "/admin/clientes";
  const hit = NAV.filter((n) => n.href !== "/admin").find((n) => path.startsWith(n.href));
  return hit?.href ?? "/admin";
}

/**
 * Menú lateral en escritorio y pestañas que se deslizan arriba en el teléfono. `current` solo para
 * las capturas (sin router); en la app sale de la ruta.
 */
export function AdminShell({
  counts,
  current,
  children,
}: {
  counts: NavCounts;
  current?: string;
  children: ReactNode;
}) {
  const path = usePathname() ?? "";
  const active = current ?? sectionOf(path);
  const title = NAV.find((n) => n.href === active)?.label ?? "Administración";
  const tabsRef = useRef<HTMLElement>(null);
  // La pestaña actual queda a la vista en el teléfono.
  // biome-ignore lint/correctness/useExhaustiveDependencies: depende de la sección.
  useEffect(() => {
    tabsRef.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [active]);
  const link = (cls: string) =>
    NAV.map((n) => {
      const c = "countKey" in n ? counts[n.countKey] : 0;
      return (
        <a
          key={n.href}
          className={cls}
          href={n.href}
          aria-current={active === n.href ? "page" : undefined}
        >
          <span aria-hidden="true">{n.icon}</span>
          {n.label}
          {c ? (
            <span className="ad-count" role="status" aria-label={`${c} pendientes`}>
              {c}
            </span>
          ) : null}
        </a>
      );
    });
  return (
    <div className="ad-app">
      <nav className="ad-side" aria-label="Secciones del administrador">
        <div className="ad-brand">
          <span className="ad-brand-dot" aria-hidden="true">
            🐾
          </span>
          Rocco · Admin
        </div>
        {link("ad-side-link")}
        <div className="ad-side-foot">
          <a href="/inicio">← Ir a mi panel</a>
        </div>
      </nav>
      <div className="ad-col">
        <header className="ad-top">
          <div className="ad-top-row">
            <div className="ad-brand">
              <span className="ad-brand-dot" aria-hidden="true">
                🐾
              </span>
              <span>{title}</span>
            </div>
            <a className="ad-note" href="/inicio">
              Mi panel
            </a>
          </div>
          <nav className="ad-tabs" aria-label="Secciones del administrador" ref={tabsRef}>
            {link("ad-tab")}
          </nav>
        </header>
        <main className="ad-main">{children}</main>
      </div>
    </div>
  );
}
