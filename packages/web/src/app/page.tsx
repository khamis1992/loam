export default function RootPage() {
  if (typeof window !== 'undefined') window.location.href = '/app';
  return null;
}
