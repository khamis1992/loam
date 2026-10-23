const quotes = [
  {
    quote: "انخفضت دورة المراجعة لدينا من أيّام إلى ساعات حين توقّف السياق عن الضياع.",
    name: "دانا ر.",
    role: "قائدة هندسة",
  },
  {
    quote: "أول أداة تبقى بعيدة عن طريقك وتفي بتنظيم كل شيء في الوقت نفسه.",
    name: "بريا س.",
    role: "مؤسِّسة",
  },
  {
    quote: "أثق في النتيجة لأنني أرى بالضبط ما تغيّر ولماذا.",
    name: "توماس ب.",
    role: "مدير منتج",
  },
];

export default function RtlTestimonialsBlock() {
  return (
    <section dir="rtl" className="bg-background">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="text-center text-2xl font-semibold tracking-tight text-foreground">
          فرق تعمل مع لوم
        </h2>
        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {quotes.map((item) => (
            <figure key={item.name} className="flex flex-col rounded-lg border border-border p-6">
              <blockquote className="flex-1 text-sm leading-6 text-foreground">
                “{item.quote}”
              </blockquote>
              <figcaption className="mt-6 flex items-center gap-3">
                <div className="h-9 w-9 rounded-full bg-muted" aria-hidden="true" />
                <div>
                  <p className="text-sm font-medium text-foreground">{item.name}</p>
                  <p className="text-xs text-muted-foreground">{item.role}</p>
                </div>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
