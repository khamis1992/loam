const faqs = [
  {
    q: "هل يعمل لوم دون اتصال بالإنترنت؟",
    a: "نعم. يعمل الوكيل الأساسي على جهازك، لذلك يستمر عملك دون اتصال بالشبكة.",
  },
  {
    q: "أين تُحفَظ بياناتي؟",
    a: "تبقى كل شيء في مساحة عملك المحلية، ولا يُرفَع أي شيء إلا إذا ربطت خدمة سحابية بنفسك.",
  },
  {
    q: "هل يمكنني استخدام نموذجي الخاص؟",
    a: "نعم. يدعم لوم النماذج المحلية ونقاط النهاية المتوافقة مع OpenAI، مع خيار إدخال مفتاحك الخاص.",
  },
  {
    q: "كيف أتراجع عن تغيير؟",
    a: "كل تغيير مُسجَّل. افتح لوحة السجل لمراجعة أي خطوة والرجوع عنها.",
  },
];

export default function RtlFaqAccordionBlock() {
  return (
    <section dir="rtl" className="bg-background">
      <div className="mx-auto max-w-3xl px-6 py-20">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">الأسئلة الشائعة</h2>
        <div className="mt-8 divide-y divide-border rounded-lg border border-border">
          {faqs.map((faq) => (
            <details key={faq.q} className="group px-5 py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-foreground">
                {faq.q}
                <span className="ms-4 text-muted-foreground transition-transform group-open:rotate-45">+</span>
              </summary>
              <p className="mt-3 text-sm leading-6 text-muted-foreground">{faq.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
