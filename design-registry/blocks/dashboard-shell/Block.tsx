const nav = ["Overview", "Tasks", "Reports", "Settings"];

export default function DashboardShellBlock() {
  return (
    <div className="grid min-h-screen grid-cols-[240px_1fr] bg-background">
      <aside className="flex flex-col gap-1 border-e border-border p-4">
        <div className="mb-4 px-2 text-sm font-semibold text-foreground">Acme</div>
        {nav.map((item) => (
          <a
            key={item}
            href="#"
            className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {item}
          </a>
        ))}
      </aside>
      <div className="flex flex-col">
        <header className="flex h-14 items-center justify-between border-b border-border px-6">
          <h1 className="text-sm font-medium text-foreground">Overview</h1>
          <div className="h-8 w-8 rounded-full bg-muted" aria-hidden="true" />
        </header>
        <main className="grid flex-1 gap-4 p-6 sm:grid-cols-2 lg:grid-cols-4">
          {["Open tasks", "Done this week", "Active agents", "Errors"].map((label) => (
            <div key={label} className="rounded-lg border border-border p-4">
              <p className="text-sm text-muted-foreground">{label}</p>
              <p className="mt-2 text-2xl font-semibold text-foreground">—</p>
            </div>
          ))}
        </main>
      </div>
    </div>
  );
}
