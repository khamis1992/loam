import type {Page} from 'playwright';
export function checkAssetOperationsUI(page:Page,fixtures:{image:string;video:string},context:{taskId:string;workspace:string;base:string}):Promise<void>;
