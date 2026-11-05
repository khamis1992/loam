export interface TemplatePreview {
  id: 'anime' | 'budget' | 'fashion' | 'focus-timer' | 'habit-tracker' | 'kanban';
  kind: 'Video' | 'App' | 'Image';
  title: string;
  description: string;
  prompt: string;
  imageSrc: string;
  imageAlt: string;
  previewSrc: string;
  related: Array<{ title: string; image: string; templateId?: TemplatePreview['id'] }>;
}

export const BUDGET_TEMPLATE: TemplatePreview = {
  id: 'budget',
  kind: 'App',
  title: 'Build a personal budget app',
  description: 'A practical budgeting workspace with monthly summaries, category limits and spending charts.',
  prompt: 'Build a budgeting workspace where I can record income and expenses, set category limits, review spending trends and export my data locally. Include an overview, category charts and simple guidance based on the numbers.',
  imageSrc: '/templates/budget.png',
  imageAlt: 'Build a personal budget app',
  previewSrc: '/template-previews/budget-preview.png',
  related: [
    { title: 'Build a focus timer with ambient sounds', image: '/template-previews/app-focus-timer.png', templateId: 'focus-timer' },
    { title: 'Build a habit tracker app', image: '/template-previews/app-habit-tracker.png', templateId: 'habit-tracker' },
    { title: 'Build a kanban board for a small team', image: '/template-previews/app-kanban.png', templateId: 'kanban' },
  ],
};

export const APP_TEMPLATE_PREVIEWS: TemplatePreview[] = [
  BUDGET_TEMPLATE,
  {
    id: 'focus-timer', kind: 'App', title: 'Build a focus timer with ambient sounds',
    description: 'A focused timer with presets, start, pause, reset, and ambient soundscapes.',
    prompt: 'Build a focus timer with 25-minute focus sessions, short and long breaks, start, pause, reset, and ambient sounds.',
    imageSrc: '/template-previews/app-focus-timer.png', imageAlt: 'Build a focus timer with ambient sounds', previewSrc: '', related: [],
  },
  {
    id: 'habit-tracker', kind: 'App', title: 'Build a habit tracker app',
    description: 'A simple habit tracker with daily check-ins, weekly progress, and new habits.',
    prompt: 'Build a habit tracker with daily check-ins, weekly progress, streaks, and the ability to add and remove habits.',
    imageSrc: '/template-previews/app-habit-tracker.png', imageAlt: 'Build a habit tracker app', previewSrc: '', related: [],
  },
  {
    id: 'kanban', kind: 'App', title: 'Build a kanban board for a small team',
    description: 'A lightweight team board with tasks, columns, and drag-free status controls.',
    prompt: 'Build a kanban board for a small team with to do, in progress, and done columns, task creation, movement, and deletion.',
    imageSrc: '/template-previews/app-kanban.png', imageAlt: 'Build a kanban board for a small team', previewSrc: '', related: [],
  },
];
