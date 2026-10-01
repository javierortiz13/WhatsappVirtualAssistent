/**
 * Enlaces cortos para campañas: `/ir/<slug>` redirige al destino con sus UTM. Un enlace por
 * canal, así cada anuncio o publicación se distingue en Vercel Analytics y en el registro.
 * Convención: utm_source = canal, utm_medium = formato, utm_campaign = nombre corto de la pieza.
 */
export const LINKS: Record<
  string,
  { to: string; source: string; medium: string; campaign: string }
> = {
  ig: { to: "/", source: "instagram", medium: "bio", campaign: "lanzamiento" },
  igad: { to: "/", source: "instagram", medium: "ad", campaign: "lanzamiento" },
  fb: { to: "/", source: "facebook", medium: "post", campaign: "lanzamiento" },
  tiktok: { to: "/", source: "tiktok", medium: "video", campaign: "lanzamiento" },
  wa: { to: "/", source: "whatsapp", medium: "estado", campaign: "lanzamiento" },
  flyer: { to: "/", source: "flyer", medium: "qr", campaign: "autolavados" },
  registro: { to: "/registro", source: "whatsapp", medium: "mensaje", campaign: "piloto" },
};
