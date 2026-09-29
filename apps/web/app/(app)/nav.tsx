"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  {
    href: "/inicio",
    label: "Inicio",
    d: "M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-6H9v6H5a2 2 0 0 1-2-2z",
  },
  {
    href: "/movimientos",
    label: "Movimientos",
    d: "M4 6h16M4 12h16M4 18h10",
  },
  {
    href: "/cierres",
    label: "Cierres",
    d: "M5 20V10m7 10V4m7 16v-7",
  },
  {
    href: "/ajustes",
    label: "Ajustes",
    d: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-1.7-1L14.8 3H9.2l-.4 2.6a7.5 7.5 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 1.7 1l.4 2.6h5.6l.4-2.6a7.5 7.5 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6c.1-.3.1-.7.1-1z",
  },
];

export function Nav() {
  const path = usePathname();
  return (
    <nav className="nav" aria-label="Secciones">
      {TABS.map((t) => {
        const active = path === t.href || path.startsWith(`${t.href}/`);
        return (
          <Link key={t.href} href={t.href} aria-current={active ? "page" : undefined}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d={t.d} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
