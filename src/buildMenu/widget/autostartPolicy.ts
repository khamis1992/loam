export type AutostartReason = 'default' | 'grant_required' | 'portable_unsupported' | 'disabled' | 'not_applied' | 'startup is unavailable';

export interface AutostartDecision {
  enabled: false;
  reason: AutostartReason;
}

export type WidgetReleaseMode = 'portable' | 'development' | 'installed';

export interface AutostartInput {
  requested: boolean;
  userGranted: boolean;
  portable: boolean;
  mode?: WidgetReleaseMode;
}

export function decideAutostart(input: AutostartInput): AutostartDecision {
  if (input.mode !== undefined && input.requested && input.userGranted) {
    switch (input.mode) {
      case 'portable':
      case 'development':
      case 'installed':
        return { enabled: false, reason: 'startup is unavailable' };
      default: {
        const unknown: never = input.mode;
        return unknown;
      }
    }
  }
  if (input.portable) return { enabled: false, reason: 'portable_unsupported' };
  if (input.requested && !input.userGranted) return { enabled: false, reason: 'grant_required' };
  if (!input.requested) return { enabled: false, reason: input.userGranted ? 'disabled' : 'default' };
  return { enabled: false, reason: 'not_applied' };
}

export interface WidgetReleaseRow {
  mode: WidgetReleaseMode;
  enabled: false;
  reason: AutostartReason;
  startupFolder: false;
  signed: false;
  built: false;
}

export function widgetPortableLabel(): string {
  return 'النسخة المحمولة غير موقّعة ولم يُبنَ ملف تنفيذي من هذه الصفحة. لا مجلد بدء تشغيل بديل.';
}

export function widgetReleaseRow(mode: WidgetReleaseMode): WidgetReleaseRow {
  const decision = decideAutostart({ requested: true, userGranted: true, portable: mode === 'portable' });
  switch (mode) {
    case 'portable':
    case 'development':
    case 'installed':
      return {
        mode,
        enabled: decision.enabled,
        reason: decision.reason,
        startupFolder: false,
        signed: false,
        built: false,
      };
    default: {
      const unknown: never = mode;
      return unknown;
    }
  }
}

export function widgetReleaseMatrix(): readonly WidgetReleaseRow[] {
  return [widgetReleaseRow('portable'), widgetReleaseRow('development'), widgetReleaseRow('installed')];
}
