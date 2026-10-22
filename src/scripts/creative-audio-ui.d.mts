import type {Page} from 'playwright';
export function checkAudioModel():void;
export function checkAudioUI(page:Page,fixtures:{image:string;video:string},context:{taskId:string;workspace:string;base:string}):Promise<void>;
