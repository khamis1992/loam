const featured = {
  title: "How focused workspaces change team output",
  excerpt: "Why giving each task its own context is the highest-leverage change a small team can make.",
  date: "2026-10-12",
  category: "Product",
};

const posts = [
  { title: "Designing for clarity over features", date: "2026-10-05", category: "Design", minutes: 6 },
  { title: "A practical guide to review loops", date: "2026-09-28", category: "Engineering", minutes: 9 },
  { title: "What we learned shipping memory", date: "2026-09-20", category: "Product", minutes: 4 },
];

export default function BlogListBlock() {
  return (
    <section className="bg-background">
      <div className="mx-auto max-w-5xl px-6 py-20">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">From the blog</h2>

        <a href="#" className="mt-8 block rounded-lg border border-border p-6">
          <span className="text-xs font-medium uppercase tracking-wide text-primary">Featured</span>
          <h3 className="mt-2 text-xl font-semibold text-foreground">{featured.title}</h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{featured.excerpt}</p>
          <p className="mt-4 text-xs text-muted-foreground">
            {featured.date} · {featured.category}
          </p>
        </a>

        <ul className="mt-8 divide-y divide-border border-y border-border">
          {posts.map((post) => (
            <li key={post.title}>
              <a href="#" className="flex items-center justify-between gap-4 py-4">
                <div>
                  <h3 className="text-sm font-medium text-foreground">{post.title}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {post.date} · {post.category}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{post.minutes} min</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
