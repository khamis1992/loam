export type Scenario = 'file-organizer' | 'habit-tracker' | 'markdown-editor' | 'password-manager' | 'photo-sorter';

export interface LocalFile { name: string; size: number; modifiedAt: string; tags: string[] }
export interface Habit { id: string; name: string; reminder: string; days: number[]; completions: string[]; streak: number; completedToday: boolean; weeklyCompletions: number }
export interface SecretRecord { id: string; service: string; username: string }
export interface PhotoRecord { name: string; size: number; sha256: string; duplicateOf: string | null }

export interface DesktopApi {
  getMetadata(): Promise<{ scenario: Scenario; title: string; version: number }>;
  listFiles(filters: { query: string; tag: string }): Promise<LocalFile[]>;
  addTag(name: string, tag: string): Promise<LocalFile[]>;
  listHabits(): Promise<Habit[]>;
  addHabit(input: { name: string; reminder: string; days: number[] }): Promise<Habit[]>;
  completeHabit(id: string): Promise<Habit[]>;
  listDocuments(): Promise<string[]>;
  readDocument(name: string): Promise<{ name: string; content: string }>;
  writeDocument(name: string, content: string): Promise<{ name: string; content: string }>;
  listSecrets(): Promise<SecretRecord[]>;
  unlockVault(): Promise<{ locked: boolean }>;
  lockVault(): Promise<{ locked: boolean }>;
  addSecret(input: { service: string; username: string; secret: string }): Promise<SecretRecord[]>;
  revealSecret(id: string): Promise<string>;
  removeSecret(id: string): Promise<SecretRecord[]>;
  scanPhotos(): Promise<PhotoRecord[]>;
  sortPhotos(): Promise<{ files: PhotoRecord[]; sortedCount: number }>;
}
