import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Ramin Life OS",
    short_name: "Life OS",
    description: "A private workspace for tasks, projects, calendar and time.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#15171c",
    theme_color: "#15171c",
    lang: "fa",
    dir: "rtl",
    icons: [
      {
        src: "/icons/life-os-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/life-os-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/life-os-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
    shortcuts: [
      { name: "Tasks", short_name: "Tasks", url: "/tasks" },
      { name: "Calendar", short_name: "Calendar", url: "/calendar" },
    ],
  };
}
