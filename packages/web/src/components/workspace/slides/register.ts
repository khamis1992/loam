import { registerEditor } from "../registry";

registerEditor({
  kind: "slides",
  label: "Slides",
  extensions: [".pptx"],
  load: () => import("./Editor"),
});
