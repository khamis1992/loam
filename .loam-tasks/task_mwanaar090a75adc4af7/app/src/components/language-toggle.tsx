import { Languages } from "lucide-react";
import { useTheme } from "./theme-provider";
import { Button } from "./ui/button";

export function LanguageToggle() {
  const { direction, toggleDirection } = useTheme();
  const next = direction === "rtl" ? "LTR" : "RTL";

  return (
    <Button variant="outline" size="sm" onClick={toggleDirection} aria-label={`Switch to ${next} layout`}>
      <Languages className="size-4" />
      <span>{next}</span>
    </Button>
  );
}
