import { BuildLauncher } from '@/components/build/BuildLauncher';

/** W-U3 — /app/build: the single builder entry (one brief, three build styles). */
export default function BuildPage() {
  return (
    <div className="flex h-full flex-1 flex-col overflow-y-auto bg-bg-main">
      <div className="px-6 py-10">
        <BuildLauncher />
      </div>
    </div>
  );
}
