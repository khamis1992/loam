const features = [
  {
    title: "مساحات عمل معزولة",
    body: "لكل مهمة ملفاتها وأدواتها وسجلّها الخاص، فلا يختلط شيء بآخر.",
    span: "lg:col-span-2",
  },
  { title: "أدوات مركّزة", body: "تظهر فقط الأدوات التي تستخدمها المهمة." },
  { title: "مراجعة مدمجة", body: "تُفحص كل تغيير قبل اعتماده." },
];

export default function RtlBentoGridBlock() {
  return (
    <section dir="rtl" className="bg-background">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="mb-10 max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground">
            مساحة عمل تتكيّف مع طبيعة العمل
          </h2>
          <p className="mt-3 text-base text-muted-foreground">
            يقود التصميم القدرة الأهم، وتترتّب العناصر الداعمة من حولها.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className={`rounded-lg border border-border bg-card p-6 ${feature.span}`}
            >
              <h3 className="text-lg font-medium text-card-foreground">{feature.title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{feature.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
