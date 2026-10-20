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
    // Rocco V1. `any`: la marca en su cuadro oscuro; `maskable`: a sangre, la marca dentro del 80 %.
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
