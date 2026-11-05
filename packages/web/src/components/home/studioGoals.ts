export type StudioGoalIcon =
  | 'website' | 'desktop' | 'widget' | 'automation' | 'notebook' | 'mobile'
  | 'chrome' | 'safari' | 'game' | 'slides' | 'document' | 'spreadsheet'
  | 'visualization' | 'image' | 'video' | 'audio';

export interface StudioGoal {
  id: string;
  label: string;
  title: string;
  placeholder: string;
  loamMode: string;
  icon: StudioGoalIcon;
  suggestions: string[];
  section?: 'Document' | 'Media';
  description?: string;
  subtitle?: string;
  outputType?: 'website' | 'slides' | 'image' | 'video';
  directRoute?: string;
  actionLabel?: string;
  actionPrompt?: string;
  actionRoute?: string;
  fullPage?: boolean;
  disabled?: boolean;
  formats?: string[];
  charts?: string[];
}

export const BUILD_GOALS: StudioGoal[] = [
  {
    id: 'websites', label: 'Websites', title: 'Your idea, live on the web',
    subtitle: 'Describe it in a sentence. Loam designs and builds the site.',
    description: 'Stores, booking sites, landing pages and chatbots — built from one sentence.',
    placeholder: 'Describe the website you want to build', loamMode: 'build', icon: 'website', outputType: 'website',
    suggestions: ['Landing Page', 'SaaS', 'E-commerce', 'Productivity', 'Portfolio', 'Education'],
  },
  {
    id: 'desktop-app', label: 'Desktop app', title: 'Build a desktop app',
    placeholder: 'Describe the desktop app you want to build', loamMode: 'build', icon: 'desktop',
    suggestions: [
      'Build a local screenshot organizer with tagging and search',
      'Create a daily focus dashboard with a timer and notes',
      'Build a private bookmark search tool with saved collections',
      'Design a lightweight invoice and expense tracker',
      'Create a media library with duplicate file detection',
    ],
  },
  {
    id: 'desktop-widget', label: 'Desktop widget', title: 'Build a desktop widget',
    placeholder: 'Describe the desktop widget you want to build', loamMode: 'build', icon: 'widget',
    suggestions: [
      'Add a battery and connectivity status widget',
      'Create a focus reminder with custom quiet hours',
      'Build a mini calendar with upcoming events',
      'Create a weather widget with hourly updates',
      'Build a quick notes widget with local saving',
    ],
  },
  {
    id: 'automations', label: 'Automations', title: 'Automate your work',
    placeholder: 'Give Loam a task to work on', loamMode: 'automate', icon: 'automation',
    directRoute: '/app/automations',
    suggestions: ['Schedule', 'Triggered task', 'Advanced automation'],
  },
  {
    id: 'jupyter-notebook', label: 'Jupyter notebook', title: 'Build a Jupyter notebook',
    placeholder: 'Describe the notebook you want to create', loamMode: 'build', icon: 'notebook',
    suggestions: [
      'Build a notebook that compares rental scenarios',
      'Create a notebook for cleaning monthly sales data',
      'Analyze household spending with clear visual summaries',
      'Build a notebook for visualizing delivery times',
      'Create a guided data-quality report with charts',
    ],
  },
  {
    id: 'mobile-app', label: 'Mobile app', title: 'Build a mobile app',
    placeholder: 'Describe the mobile app you want to build', loamMode: 'build', icon: 'mobile',
    suggestions: [
      'Create a private mood journal with gentle check-ins',
      'Build a shared shopping list with live updates',
      'Create a recipe planner with automatic grocery lists',
      'Build a flashcard trainer with review schedules',
      'Create a travel expense log with receipt notes',
    ],
  },
  {
    id: 'chrome-extension', label: 'Chrome extension', title: 'Build a Chrome extension',
    placeholder: 'Describe the Chrome extension you want to build', loamMode: 'build', icon: 'chrome',
    suggestions: [
      'Create a selected-text reading mode',
      'Build a tab snooze and restore tool',
      'Create a coupon and price alert extension',
      'Build a bookmark duplicate finder',
      'Create a quick note side panel',
    ],
  },
  {
    id: 'safari-extension', label: 'Safari extension', title: 'Build a Safari extension',
    placeholder: 'Describe the Safari extension you want to build', loamMode: 'build', icon: 'safari',
    suggestions: [
      'Create a link cleaner for tracking parameters',
      'Build a reading list exporter',
      'Create a tab group saver',
      'Build a distraction-free reader',
      'Create a page zoom and contrast helper',
    ],
  },
  {
    id: 'game-development', label: 'Game development', title: 'Press start on any idea.',
    subtitle: 'Loam builds it — worlds, rules, art and sound.',
    placeholder: 'Describe the game you want to build', loamMode: 'build', icon: 'game', fullPage: true,
    suggestions: ['Iron Rift FPS', 'Space Worm 3D', 'Side Scroller', 'The Rogue'],
  },
];

export const CREATE_GOALS: StudioGoal[] = [
  {
    id: 'slides', label: 'Slides', title: 'Create a presentation', section: 'Document',
    placeholder: 'Describe your presentation topic', loamMode: 'write', icon: 'slides', outputType: 'slides',
    actionLabel: 'New blank presentation', actionPrompt: 'Create a blank presentation that I can edit.',
    suggestions: [
      'Compare three competitors and propose a launch strategy',
      'Summarize market size and customer segments',
      'Turn monthly results into a clear leadership update',
    ],
  },
  {
    id: 'document', label: 'Document', title: 'Create a document', section: 'Document',
    placeholder: 'Describe the document you want to create', loamMode: 'write', icon: 'document',
    actionLabel: 'New blank document', actionPrompt: 'Create a blank document that I can edit.',
    suggestions: [
      'Write a findings report with evidence and next steps',
      'Draft a client success story with measurable outcomes',
      'Create a project brief with goals and deliverables',
      'Prepare an employee onboarding guide',
      'Write a quarterly review with priorities and risks',
      'Plan an event checklist with owners and timeline',
    ],
  },
  {
    id: 'spreadsheet', label: 'Spreadsheet', title: 'Create a spreadsheet', section: 'Document',
    placeholder: 'Upload a spreadsheet to analyze or start one from scratch', loamMode: 'data', icon: 'spreadsheet',
    actionLabel: 'New blank spreadsheet', actionPrompt: 'Create a blank spreadsheet that I can edit.',
    suggestions: [
      'Create a legal due diligence checklist for an acquisition',
      'Build a cash-flow model with editable assumptions',
      'Track personal spending with monthly summaries',
      'Calculate investment returns from cash flows',
      'Organize project tasks and milestones',
      'Analyze regional energy data and trends',
    ],
  },
  {
    id: 'visualization', label: 'Visualization', title: 'Create a visualization', section: 'Document',
    placeholder: 'Upload your data and tell Loam how to visualize it', loamMode: 'data', icon: 'visualization',
    formats: ['Graph', 'Slides', 'Website', 'Spreadsheet', 'Report'],
    charts: ['Bar', 'Line', 'Pie', 'Scatter', 'Heat map', 'Bubble'],
    suggestions: [
      'Explore churn drivers with charts and findings',
      'Build an expense dashboard with filters',
      'Track project milestones and resource use',
    ],
  },
  {
    id: 'image', label: 'Image', title: 'Create a design', section: 'Media',
    placeholder: 'Describe the image you want to create', loamMode: 'media', icon: 'image', outputType: 'image',
    actionLabel: 'Open Canvas', actionRoute: '/app/design',
    suggestions: [
      'Design a book cover and matching page layout',
      'Create a smartwatch package concept',
      'Design a festival poster and social cards',
      'Create a restaurant menu with clear sections',
      'Build an infographic about daily coffee habits',
      'Design a calm meditation app landing page',
    ],
  },
  {
    id: 'video', label: 'Video', title: 'Create a video', section: 'Media',
    placeholder: 'Describe the video you want to create', loamMode: 'media', icon: 'video', outputType: 'video',
    actionLabel: 'Open video studio', actionRoute: '/app/video', fullPage: true,
    suggestions: ['Short film', 'Promotional ad', 'Explainer', 'Product showcase'],
  },
  {
    id: 'audio', label: 'Audio', title: 'Create audio', section: 'Media',
    placeholder: 'Describe the audio you want to create', loamMode: 'media', icon: 'audio',
    suggestions: [
      'Turn a research paper into a short podcast',
      'Create an onboarding narration for new employees',
      'Summarize a daily email digest as audio',
      'Generate a five-minute ocean meditation',
      'Convert a technical article into a spoken explainer',
      'Create a slide narration script for a physics lesson',
    ],
  },
];
