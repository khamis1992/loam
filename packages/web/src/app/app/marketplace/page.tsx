import MarketplacePageClient from './MarketplacePageClient';

export default function MarketplacePage() {
  return (
    <div className="flex h-full flex-1 flex-col overflow-y-auto bg-bg-main">
      <MarketplacePageClient />
    </div>
  );
}
