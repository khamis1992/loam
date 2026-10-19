import type {Page} from 'playwright';
export function checkLutModel():void;
export function checkLutUI(page:Page,fixtures:{image:string;video:string},context:{taskId:string;workspace:string;base:string}):Promise<void>;
