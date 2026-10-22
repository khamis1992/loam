export function VoiceIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M12 4v16" />
      <path d="M8 8v8" />
      <path d="M16 8v8" />
      <path d="M4 10v4" />
      <path d="M20 10v4" />
    </svg>
  );
}
