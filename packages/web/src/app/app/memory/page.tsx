import { MemoryHub } from '@/components/memory/MemoryHub';

/** W-U3 — /app/memory: the unified memory page (memories, garden, lessons, wiki). */
export default function MemoryPage() {
  return (
    <div className="flex h-full flex-1 flex-col overflow-y-auto bg-bg-main">
      <MemoryHub />
    </div>
  );
}
