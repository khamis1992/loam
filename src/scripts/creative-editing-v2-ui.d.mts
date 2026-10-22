import type {Page} from 'playwright';
export function checkEditingToolsModel():void;
export function checkEditingToolsUI(page:Page,fixtures:{image:string;video:string}):Promise<void>;
