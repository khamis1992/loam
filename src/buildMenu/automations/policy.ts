export type RoutineEffect = 'local-report' | 'external-send' | 'publish' | 'purchase' | 'delete';

export function authorizeStep(effect: RoutineEffect): 'allowed' | 'approval-required' {
  switch (effect) {
    case 'local-report':
      return 'allowed';
    case 'external-send':
    case 'publish':
    case 'purchase':
    case 'delete':
      return 'approval-required';
    default: {
      const unknown: never = effect;
      return unknown;
    }
  }
}

export interface RoutineSpec {
  version: 1;
  prompt: string;
  cron: string;
  timezone: 'Asia/Qatar';
  enabled: boolean;
  effects: readonly RoutineEffect[];
}
