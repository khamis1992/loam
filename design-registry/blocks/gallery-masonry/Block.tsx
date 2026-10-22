const items = [
  { src: "/images/work-1.jpg", caption: "Studio interior", tall: true },
  { src: "/images/work-2.jpg", caption: "Product detail" },
  { src: "/images/work-3.jpg", caption: "Brand system", tall: true },
  { src: "/images/work-4.jpg", caption: "Packaging" },
  { src: "/images/work-5.jpg", caption: "Editorial spread", tall: true },
  { src: "/images/work-6.jpg", caption: "Web interface" },
];

export default function GalleryMasonryBlock() {
  return (
    <section className="bg-background">
      <div className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">Selected work</h2>
        <div className="mt-8 columns-1 gap-4 sm:columns-2 lg:columns-3">
          {items.map((item) => (
            <figure key={item.src} className="group relative mb-4 break-inside-avoid overflow-hidden rounded-lg border border-border">
              <img
                src={item.src}
                alt={item.caption}
                className={`w-full object-cover ${item.tall ? "aspect-[3/4]" : "aspect-[4/3]"}`}
              />
              <figcaption className="absolute inset-x-0 bottom-0 bg-foreground/70 px-3 py-2 text-xs text-background opacity-0 transition-opacity group-hover:opacity-100">
                {item.caption}
              </figcaption>
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
