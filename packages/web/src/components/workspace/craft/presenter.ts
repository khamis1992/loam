import { CRAFT_APPS, type CraftApp } from '@/lib/craftBridge';

export function openCraftPresenter(app: CraftApp, fallbackFullscreen: () => void): 'window' | 'fullscreen' {
  const popup = window.open(`loamcraft://${CRAFT_APPS[app].internalId}/index.html?loam=1`, '_blank', 'width=1280,height=720');
  if (popup) {
    popup.focus();
    return 'window';
  }
  fallbackFullscreen();
  return 'fullscreen';
}
