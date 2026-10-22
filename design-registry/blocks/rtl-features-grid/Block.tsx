const features = [
  { title: "سياق معزول", body: "لا ترى كل مهمة إلا ما تحتاجه فقط." },
  { title: "أدوات مركّزة", body: "مجموعة الأدوات تطابق طبيعة العمل." },
  { title: "سجلّ كامل", body: "كل تغيير موثّق ويمكن الرجوع عنه." },
  { title: "مراجعة مدمجة", body: "يُفحص العمل قبل أن يُعتمد." },
  { title: "ذاكرة مشتركة", body: "سياق يُستعاد بين المهام المترابطة." },
  { title: "محلي أولًا", body: "يعمل على جهازك ويحفظ بياناتك لك." },
];

export default function RtlFeaturesGridBlock() {
  return (
    <section dir="rtl" className="bg-background">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <div className="mb-12 max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground">
            مصمَّم للعمل المركّز
          </h2>
          <p className="mt-3 text-base text-muted-foreground">
            مجموعة صغيرة من القدرات تعمل معًا، بدلًا من مجموعة كبيرة تعيق عملك.
          </p>
        </div>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div key={feature.title} className="rounded-lg border border-border p-6">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M5 13l4 4L19 7"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
              <h3 className="mt-4 text-base font-medium text-foreground">{feature.title}</h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{feature.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
