const plans = [
  {
    name: "الأساسية",
    price: "٠",
    blurb: "لتجربة لوم على مشروع واحد.",
    features: ["مساحة عمل واحدة", "الأدوات الأساسية", "دعم المجتمع"],
    cta: "ابدأ مجانًا",
    featured: false,
  },
  {
    name: "الاحترافية",
    price: "٤٥",
    blurb: "للمحترفين الذين يُسلِمون كل أسبوع.",
    features: ["مساحات عمل غير محدودة", "كل الأدوات", "دعم ذو أولوية", "تصدير السجل"],
    cta: "ابدأ الاحترافية",
    featured: true,
  },
  {
    name: "الفِرق",
    price: "١٠٩",
    blurb: "للفرق التي تحتاج إلى سياق مشترك.",
    features: ["كل مزايا الاحترافية", "ذاكرة مشتركة", "صلاحيات حسب الدور", "سجل تدقيق"],
    cta: "تواصل مع المبيعات",
    featured: false,
  },
];

export default function RtlPricingThreeTierBlock() {
  return (
    <section dir="rtl" className="bg-background">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="mb-12 text-center">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground">
            أسعار بسيطة تنمو معك
          </h2>
          <p className="mt-3 text-muted-foreground">
            ابدأ مجانًا وقم بالترقية عندما يتجاوز عملك مساحة عمل واحدة.
          </p>
        </div>
        <div className="grid gap-6 md:grid-cols-3">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className={`flex flex-col rounded-lg border p-6 ${
                plan.featured ? "border-primary bg-card" : "border-border"
              }`}
            >
              <h3 className="text-lg font-medium text-foreground">{plan.name}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{plan.blurb}</p>
              <p className="mt-4 text-4xl font-semibold text-foreground">{plan.price}</p>
              <ul className="mt-6 flex flex-col gap-2 text-sm text-muted-foreground">
                {plan.features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
              <a
                href="#"
                className={`mt-8 inline-flex h-10 items-center justify-center rounded-md text-sm font-medium ${
                  plan.featured
                    ? "bg-primary text-primary-foreground"
                    : "border border-border text-foreground"
                }`}
              >
                {plan.cta}
              </a>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
