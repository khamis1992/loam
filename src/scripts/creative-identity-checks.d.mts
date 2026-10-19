import type {Page} from 'playwright';
export function checkIdentityModel():void;
export function checkIdentityUI(page:Page,fixtures:{image:string;video:string},context:{taskId:string;workspace:string;base:string}):Promise<void>;
