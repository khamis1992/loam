import { useState } from "react";

const links = ["Product", "Pricing", "Docs", "Blog"];

export default function NavHeaderBlock() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur">
      <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <a href="#" className="text-sm font-semibold text-foreground">
          Loam
        </a>

        <div className="hidden items-center gap-6 md:flex">
          {links.map((link) => (
            <a key={link} href="#" className="text-sm text-muted-foreground hover:text-foreground">
              {link}
            </a>
          ))}
        </div>

        <div className="hidden items-center gap-3 md:flex">
          <a href="#" className="text-sm font-medium text-foreground">
            Sign in
          </a>
          <a
            href="#"
            className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
          >
            Get started
          </a>
        </div>

        <button
          type="button"
          aria-expanded={open}
          aria-label="Toggle navigation"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-foreground md:hidden"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </nav>

      {open && (
        <div className="flex flex-col gap-1 border-t border-border px-6 py-3 md:hidden">
          {links.map((link) => (
            <a key={link} href="#" className="py-2 text-sm text-muted-foreground">
              {link}
            </a>
          ))}
        </div>
      )}
    </header>
  );
}
