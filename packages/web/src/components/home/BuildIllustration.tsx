export function BuildIllustration() {
  return (
    <svg width="140" height="100" viewBox="0 0 140 100" fill="none" className="text-text-primary">
      <path d="M10 10H130V90H10zM10 30H130M10 50H130M10 70H130M35 10V90M60 10V90M85 10V90M110 10V90" stroke="currentColor" strokeWidth="0.8" />
      <circle cx="72" cy="50" r="35" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="72" cy="50" r="19" stroke="currentColor" strokeWidth="1.2" />
      <path d="M72 15V85M37 50H107" stroke="currentColor" strokeWidth="0.8" />
    </svg>
  );
}

export function CreateIllustration() {
  return (
    <svg width="140" height="100" viewBox="0 0 140 100" fill="none" className="text-text-primary">
      <rect x="18" y="26" width="76" height="60" rx="3" transform="rotate(-12 18 26)" stroke="currentColor" strokeWidth="1.2" />
      <rect x="36" y="18" width="76" height="60" rx="3" transform="rotate(-3 36 18)" stroke="currentColor" strokeWidth="1.2" />
      <rect x="52" y="14" width="76" height="60" rx="3" transform="rotate(8 52 14)" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function CreateMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M8 2.5 11 4v3L8 8.5 5 7V4l3-1.5Z" />
      <path d="m4 9 3 1.5v3L4 15l-3-1.5v-3L4 9Z" />
      <path d="m12 9 3 1.5v3L12 15l-3-1.5v-3L12 9Z" />
    </svg>
  );
}
