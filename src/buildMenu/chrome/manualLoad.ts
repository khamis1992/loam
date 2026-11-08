const LINES = [
  'Load unpacked is manual.',
  'Ignored flags mean the browser test did not run.',
  'storage.local in a real profile is unproven.',
] as const;

export interface ChromeManualHandoff {
  loadUnpacked: 'manual';
  extensionLoaded: false;
  browserTestRan: false;
  ignoredFlagsMean: 'browser-test-did-not-run';
  storageLocalRealProfile: 'unproven';
  lines: typeof LINES;
}

const HANDOFF: ChromeManualHandoff = Object.freeze({
  loadUnpacked: 'manual',
  extensionLoaded: false,
  browserTestRan: false,
  ignoredFlagsMean: 'browser-test-did-not-run',
  storageLocalRealProfile: 'unproven',
  lines: Object.freeze(LINES),
});

export function chromeManualLoad(): ChromeManualHandoff {
  return HANDOFF;
}
