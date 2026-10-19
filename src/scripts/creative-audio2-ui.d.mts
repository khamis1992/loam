import type {Page} from 'playwright';
export function checkAudioAdvancedModel():void;
export function checkAudioAdvancedUI(page:Page,fixtures:{image:string;video:string},context:{taskId:string;workspace:string;base:string}):Promise<void>;
