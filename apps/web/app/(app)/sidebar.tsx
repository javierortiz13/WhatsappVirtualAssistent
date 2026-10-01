"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import {
  IconBars,
  IconChat,
  IconClose,
  IconDownload,
  IconGear,
  IconHome,
  IconList,
  IconLogout,
  IconMenu,
  IconPhone,
  IconTags,
} from "./icons";

export type SidebarProps = {
  tenantName: string;
  email: string;
  rateLine: string | null;
  pendingPhones: number;
  assistantUrl: string | null;
};

const TITLES: [string, string][] = [
  ["/inicio", "Inicio"],
  ["/movimientos/", "Movimiento"],
  ["/movimientos", "Movimientos"],
  ["/cierres", "Cierres"],
  ["/ajustes/categorias", "Categorías"],
  ["/ajustes/numeros", "Números de WhatsApp"],
  ["/ajustes/negocio", "Negocio"],
  ["/ajustes/exportar", "Exportar"],
  ["/ajustes", "Ajustes"],
];

function titleFor(path: string): string {
  return TITLES.find(([p]) => path === p || path.startsWith(p))?.[1] ?? "Caja";
}

/**
 * Menú lateral: en el teléfono es un cajón que abre el botón ☰ y cierra la cortina; en escritorio
 * (≥ 960 px) queda fijo a la izquierda. Los mismos enlaces en los dos casos.
 */
export function Shell({ children, ...p }: SidebarProps & { children: ReactNode }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const is = (href: string) => path === href || path.startsWith(`${href}/`);
  const item = (href: string, label: string, icon: ReactNode, badge?: ReactNode) => (
    <Link
      className="menu-item"
      href={href}
      aria-current={is(href) ? "page" : undefined}
      onClick={() => setOpen(false)}
    >
      {icon}
      {label}
      {badge}
    </Link>
  );
  return (
    <div className="shell">
      {open ? (
        <button
          className="scrim"
          type="button"
          aria-label="Cerrar menú"
          onClick={() => setOpen(false)}
        />
      ) : null}
      <nav className={`drawer${open ? " open" : ""}`} aria-label="Menú principal">
        <div className="who">
          <span className="avatar">{p.tenantName.charAt(0).toUpperCase()}</span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 15,
                fontWeight: 600,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {p.tenantName}
            </div>
            {p.rateLine ? <div className="sub">{p.rateLine}</div> : null}
          </div>
          <button
            className="iconbtn close"
            type="button"
            aria-label="Cerrar menú"
            onClick={() => setOpen(false)}
          >
            <IconClose size={18} />
          </button>
        </div>
        {item("/inicio", "Inicio", <IconHome />)}
        {item("/movimientos", "Movimientos", <IconList />)}
        {item("/cierres", "Cierres", <IconBars />)}
        <span className="sect">Negocio</span>
        {item("/ajustes/categorias", "Categorías", <IconTags />)}
        {item(
          "/ajustes/numeros",
          "Números de WhatsApp",
          <IconPhone />,
          p.pendingPhones > 0 ? <span className="badge warn">{p.pendingPhones}</span> : undefined,
        )}
        {item("/ajustes/exportar", "Exportar a Excel", <IconDownload />)}
        {item("/ajustes", "Ajustes", <IconGear />)}
        <div className="bottom">
          {p.assistantUrl ? (
            <a className="menu-item" href={p.assistantUrl} target="_blank" rel="noreferrer">
              <IconChat />
              Abrir el asistente
            </a>
          ) : null}
          <form action="/auth/logout" method="post">
            <button className="menu-item" type="submit" style={{ color: "var(--muted)" }}>
              <IconLogout />
              Cerrar sesión
            </button>
          </form>
          <span className="foot">{p.email}</span>
        </div>
      </nav>
      <main className="content">
        <div className="topbar">
          <button
            className="iconbtn menu"
            type="button"
            aria-label="Abrir menú"
            onClick={() => setOpen(true)}
          >
            <IconMenu />
          </button>
          <h1>{titleFor(path)}</h1>
          {p.rateLine ? <span className="pill">{p.rateLine}</span> : null}
        </div>
        {children}
      </main>
    </div>
  );
}
