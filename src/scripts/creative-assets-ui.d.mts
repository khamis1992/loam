import type {Page} from 'playwright';
export function checkAssetModel():void;
export function checkCreativeAssets(page:Page,fixtures:{image:string;video:string},context:{taskId:string;workspace:string;base:string}):Promise<void>;
