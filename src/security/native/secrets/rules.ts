/** Loam-authored secret rules, kept as data apart from the engine. Patterns are written fresh, not copied from any rule set. */
export interface SecretRule {
  id: string;
  description: string;
  /** Lowercase literals; a chunk must contain one before the regex runs. Empty means always run. */
  keywords: string[];
  regex: string;
  /** Capture group holding the secret. Defaults to the whole match. */
  secretGroup?: number;
  /** Shannon entropy floor for the secret; the hit is dropped at or below it. */
  entropy?: number;
  severity: "critical" | "high" | "medium";
  /** Generic rules lose to a specific rule that hit the same line. */
  generic?: boolean;
  /** Positive filter: the rule only runs on files matching this regex. */
  path?: string;
  allow?: {
    paths?: string[];
    /** Allowlist regexes; each applies to its target (default: the secret). */
    regexes?: Array<string | { re: string; target?: "secret" | "match" | "line" }>;
    stopwords?: string[];
  };
}

export const DEFAULT_RULES: SecretRule[] = [
  { id: "aws-access-key-id", description: "AWS access key id", keywords: ["akia", "asia", "abia", "acca"],
    regex: "\\b((?:AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\\b", secretGroup: 1, severity: "high" },
  { id: "github-token", description: "GitHub token", keywords: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"],
    regex: "\\b((?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{60,255}))\\b", secretGroup: 1, severity: "critical" },
  { id: "gitlab-pat", description: "GitLab personal access token", keywords: ["glpat-"],
    regex: "\\b(glpat-[A-Za-z0-9_-]{20})\\b", secretGroup: 1, severity: "critical" },
  { id: "slack-token", description: "Slack token", keywords: ["xoxb-", "xoxp-", "xoxa-", "xoxr-", "xoxs-"],
    regex: "\\b(xox[bparso]-[A-Za-z0-9-]{10,72})\\b", secretGroup: 1, severity: "high" },
  { id: "stripe-secret-key", description: "Stripe secret key", keywords: ["sk_live_", "rk_live_"],
    regex: "\\b((?:sk|rk)_live_[A-Za-z0-9]{20,99})\\b", secretGroup: 1, severity: "critical" },
  { id: "google-api-key", description: "Google API key", keywords: ["aiza"],
    regex: "\\b(AIza[A-Za-z0-9_-]{35})\\b", secretGroup: 1, severity: "high" },
  { id: "anthropic-api-key", description: "Anthropic API key", keywords: ["sk-ant-"],
    regex: "\\b(sk-ant-[A-Za-z0-9_-]{20,200})\\b", secretGroup: 1, severity: "critical" },
  { id: "openai-api-key", description: "OpenAI API key", keywords: ["sk-"],
    regex: "\\b(sk-(?:proj-)?[A-Za-z0-9_-]{32,200})\\b", secretGroup: 1, entropy: 3.5, severity: "critical" },
  { id: "npm-token", description: "npm access token", keywords: ["npm_"],
    regex: "\\b(npm_[A-Za-z0-9]{36})\\b", secretGroup: 1, severity: "critical" },
  { id: "private-key", description: "Private key block", keywords: ["-----begin"],
    regex: "(-----BEGIN[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----[\\s\\S]{40,}?-----END[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----)", secretGroup: 1, severity: "critical" },
  { id: "jwt", description: "JSON Web Token", keywords: ["eyj"],
    regex: "\\b(eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,})\\b", secretGroup: 1, entropy: 3, severity: "medium" },
  { id: "generic-api-key", description: "Generic credential assignment", generic: true,
    keywords: ["key", "token", "secret", "passwd", "password", "pwd", "credential"],
    regex: "(?i)[\\w.-]{0,40}(?:key|token|secret|passw(?:or)?d|pwd|credential)[\\w.-]{0,20}[\\s'\"`]{0,3}(?:=|:|:=|=>)[\\s'\"`=]{0,5}([A-Za-z0-9_\\-+/=.]{16,100})(?:[\\s'\"`;,)]|$)",
    secretGroup: 1, entropy: 3.5, severity: "medium",
    allow: {
      paths: ["(^|/)(package-lock\\.json|yarn\\.lock|pnpm-lock\\.yaml|Cargo\\.lock|go\\.sum)$", "\\.(svg|map|min\\.js)$"],
      regexes: ["^\\$\\{", "^<[^>]+>$", "^(?:process\\.env|os\\.environ|getenv)"],
      stopwords: ["example", "placeholder", "changeme", "your_", "your-", "xxxxxxxx", "sample", "dummy", "undefined"],
    } },
];
