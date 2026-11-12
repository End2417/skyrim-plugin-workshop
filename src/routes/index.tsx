import { createFileRoute } from "@tanstack/react-router";
import { EspEditor } from "@/components/esp/EspEditor";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Skyrim ESP Editor — read and edit plugins" },
      {
        name: "description",
        content: "Open a Skyrim Legendary Edition .esp file (or convert a Special Edition one), browse its records, edit values and save it back.",
      },
      { property: "og:title", content: "Skyrim ESP Editor" },
      {
        property: "og:description",
        content: "Open a Skyrim Legendary Edition .esp file (or convert a Special Edition one), browse its records, edit values and save it back.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: EspEditor,
});
