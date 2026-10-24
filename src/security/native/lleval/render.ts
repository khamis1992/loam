/** `{{var}}` / `{{ var }}` substitution. Unknown placeholders are left in place so missing vars are visible in results. */
export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (whole, name: string) => (name in vars ? vars[name]! : whole));
}
