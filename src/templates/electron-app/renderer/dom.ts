export function element<T extends Element>(selector: string): T {
  const found = document.querySelector(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return found as T;
}

function escaped(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function page(title: string, subtitle: string, content: string): void {
  document.title = title;
  element<HTMLElement>('#app').innerHTML = `
    <header class="hero">
      <div class="mark" aria-hidden="true">L</div>
      <div><p class="eyebrow">LOCAL DESKTOP APP</p><h1>${escaped(title)}</h1><p>${escaped(subtitle)}</p></div>
    </header>${content}`;
}

export function status(message: string): void {
  element<HTMLElement>('#status').textContent = message;
}

export function errorStatus(error: unknown): void {
  status(error instanceof Error ? error.message : String(error));
}
