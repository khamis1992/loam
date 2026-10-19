import type {Page} from 'playwright';
export function checkBlendModel():void;
export function checkBlendUI(page:Page,fixtures:{image:string;video:string},context:{taskId:string;workspace:string;base:string}):Promise<void>;
