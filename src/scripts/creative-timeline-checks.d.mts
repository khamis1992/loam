import type {Page} from 'playwright';
export function checkCreativeTimeline(page:Page,fixtures:{image:string;video:string}):Promise<{projectPath:string;outputPath:string}>;
