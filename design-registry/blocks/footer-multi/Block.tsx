const groups = [
  { title: "Product", links: ["Features", "Pricing", "Changelog", "Roadmap"] },
  { title: "Company", links: ["About", "Blog", "Careers", "Contact"] },
  { title: "Resources", links: ["Docs", "Guides", "API", "Status"] },
  { title: "Legal", links: ["Privacy", "Terms", "Security"] },
];

export default function FooterMultiBlock() {
  return (
    <footer className="border-t border-border bg-muted/40">
      <div className="mx-auto grid max-w-6xl gap-8 px-6 py-12 sm:grid-cols-2 lg:grid-cols-5">
        <div className="lg:col-span-1">
          <p className="text-sm font-semibold text-foreground">Loam</p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            Focused workspaces for teams that ship.
          </p>
        </div>
        {groups.map((group) => (
          <div key={group.title}>
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {group.title}
            </h3>
            <ul className="mt-3 flex flex-col gap-2">
              {group.links.map((link) => (
                <li key={link}>
                  <a href="#" className="text-sm text-foreground hover:underline">
                    {link}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-border px-6 py-4 text-center text-xs text-muted-foreground">
        © 2026 Loam. All rights reserved.
      </div>
    </footer>
  );
}
