import type {Page} from 'playwright';
export function checkFxModel():void;
export function checkFxUI(page:Page,fixtures:{image:string;video:string},context:{taskId:string;workspace:string;base:string}):Promise<void>;
