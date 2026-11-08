import { BuildMenuEntry } from '@/components/build/BuildMenuEntry';

/** /app/build: kind dialog first, then the existing launcher on the legacy path. */
export default function BuildPage() {
  return (
    <div className="flex h-full flex-1 flex-col overflow-y-auto bg-bg-main">
      <div className="px-6 py-10">
        <BuildMenuEntry />
      </div>
    </div>
  );
}
