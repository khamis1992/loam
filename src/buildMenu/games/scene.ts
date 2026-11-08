import fs from 'node:fs';
import path from 'node:path';
import { resolveWrite } from '../../policy/paths.js';

export interface GameScene {
  goalX: 420 | 600;
  label: string;
}

export function gameScene(brief: string): GameScene {
  const near = /هدف\s*قريب|قرب الهدف|near goal|close goal/i.test(brief);
  return near ? { goalX: 420, label: 'هدف قريب' } : { goalX: 600, label: 'هدف بعيد' };
}

function briefPath(workspace: string): string {
  try {
    return resolveWrite(workspace, path.join('app', 'brief.txt'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') throw error;
    throw new Error('unsafe_path');
  }
}

export function writeGameBrief(workspace: string, brief: string): void {
  const text = brief.replace(/\u0000/g, '').trim().slice(0, 400);
  if (!text) return;
  const target = briefPath(workspace);
  const dir = path.dirname(target);
  if (fs.existsSync(dir)) {
    const dirStat = fs.lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('unsafe_path');
  }
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
  }
  if (briefPath(workspace) !== target) throw new Error('unsafe_path');
  fs.writeFileSync(target, text);
}

export function readGameBrief(workspace: string): string {
  const target = briefPath(workspace);
  if (!fs.existsSync(target)) return '';
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error('unsafe_path');
  return fs.readFileSync(target, 'utf8').slice(0, 400);
}
