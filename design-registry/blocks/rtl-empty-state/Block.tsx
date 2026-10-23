export default function RtlEmptyStateBlock() {
  return (
    <section dir="rtl" className="flex items-center justify-center bg-background px-6 py-24">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 5v14M5 12h14"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <h2 className="text-lg font-medium text-foreground">لا توجد مهام بعد</h2>
        <p className="text-sm leading-6 text-muted-foreground">
          أنشئ مهمتك الأولى لمنح مساحة العمل هذه شيئًا تعمل عليه.
        </p>
        <a
          href="#new"
          className="mt-2 inline-flex h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground"
        >
          مهمة جديدة
        </a>
      </div>
    </section>
  );
}
