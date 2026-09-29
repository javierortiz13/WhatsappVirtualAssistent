import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Asistente de Caja",
    short_name: "Caja",
    description: "Tu caja, por WhatsApp.",
    start_url: "/inicio",
    display: "standalone",
    background_color: "#f6f7f9",
    theme_color: "#0f7b5f",
    lang: "es-VE",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
