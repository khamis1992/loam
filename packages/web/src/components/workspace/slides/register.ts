import { registerEditor } from "../registry";

registerEditor({
  kind: "slides",
  label: "Slides",
  extensions: [".pptx", ".ppt"],
  load: () => import("./Editor"),
});