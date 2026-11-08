export type SafariLabel = {
  label: 'source-only';
  safariTested: false;
  xcodeRan: false;
};

export type SafariLabelCaller = {
  platform?: string;
  xcodeRan?: boolean;
  safariTested?: boolean;
};

const SOURCE_ONLY: SafariLabel = { label: 'source-only', safariTested: false, xcodeRan: false };

export function safariLabel(caller: SafariLabelCaller = {}): SafariLabel {
  const platform = typeof caller.platform === 'string' ? caller.platform : process.platform;
  if (platform === 'win32' && (caller.xcodeRan === true || caller.safariTested === true)) {
    throw new Error('invalid_request');
  }
  return { ...SOURCE_ONLY };
}
