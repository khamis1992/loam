import type { Page } from 'playwright';
export function checkCreativeMedia(page: Page): Promise<{image:string;video:string}>;
