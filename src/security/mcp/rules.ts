import type { RawSeverity } from "../normalize/types.js";

export const MCP_INJECTION_PATTERNS: Array<[RegExp, string, RawSeverity]> = [
  [/ignore (all )?(previous|prior|above) instructions/i, "instruction-override", "critical"],
  [/(you are now|act as|pretend to be) (a|an) .{0,40}(developer|admin|root|dan)/i, "persona-injection", "high"],
  [/exfiltrat|send (this|the) (file|content|data|secret)s? (to|over)|(?:curl|wget)\s+(?:-[A-Za-z]+\s+)*https?:\/\//i, "exfil-hint", "critical"],
  [/delete (all|the) (files|workspace)|rm\s+-rf?\s+\//i, "destructive-hint", "critical"],
  [/\bAPI[_ -]?KEY\b\s*[:=]\s*[A-Za-z0-9_\-]{16,}/, "embedded-credential", "critical"],
];

export const WRITE_HINTS = /(write|save|export|render|convert|encode|build|compile)/i;
export const NET_HINTS = /(upload|publish|send|fetch|download|sync|push)/i;
