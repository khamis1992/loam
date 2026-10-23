export default function RtlHeroSplitBlock() {
  return (
    <section dir="rtl" className="bg-background">
      <div className="mx-auto grid max-w-6xl items-center gap-10 px-6 py-20 lg:grid-cols-2">
        <div className="flex flex-col gap-5">
          <h1 className="text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">
            كل مهمة في مساحة عمل مركّزة خاصة بها
          </h1>
          <p className="max-w-md text-base leading-7 text-muted-foreground">
            امنح كل عمل الأدوات والسياق الذي يحتاجه، وأبعد بقية مشروعك عن
            الطريق. تبقى التفاصيل في مكانها ويبقى تركيزك حيث يجب.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <a
              href="#start"
              className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
            >
              ابدأ مجانًا
            </a>
            <a
              href="#tour"
              className="inline-flex h-10 items-center rounded-md border border-border px-4 text-sm font-medium text-foreground"
            >
              شاهد الجولة
            </a>
          </div>
        </div>
        <img
          src="/images/hero-workspace.jpg"
          alt="مساحة عمل في لوم تُظهر مهمة مركّزة مع لوحة الأدوات"
          className="w-full rounded-lg border border-border object-cover"
        />
      </div>
    </section>
  );
}
