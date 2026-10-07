import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Rocco · Fiel a tus cuentas",
    short_name: "Rocco",
    description: "Tu amigo fiel con tus finanzas, por WhatsApp.",
    start_url: "/inicio",
    display: "standalone",
    background_color: "#0b0e13",
    theme_color: "#0b0e13",
    lang: "es-VE",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
