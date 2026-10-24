/** The nine ordinary vulnerability classes a hunter wave is assigned. Original wording. */
export interface VulnClass {
  id: string;
  name: string;
  focus: string;
  moves: string[];
}

export const CLASSES: VulnClass[] = [
  {
    id: "injection", name: "Injection",
    focus: "Untrusted data reaches an interpreter: SQL, shell, template, expression, path, header, log, XML, deserializer.",
    moves: ["List every sink that builds a command, query or markup from a string.", "Walk each sink backwards to its first untrusted source.", "Check whether an allow-list, parameterisation or escaping really sits on that path."],
  },
  {
    id: "access-control", name: "Access control",
    focus: "A caller can act on data or functions they should not reach: missing checks, IDOR, role confusion, tenant crossing.",
    moves: ["Enumerate entry points and the check each one performs.", "Compare the object a request names with the identity that sent it.", "Look for routes that skip the shared guard."],
  },
  {
    id: "resource-file", name: "Resource and file handling",
    focus: "Paths, uploads, archives, temp files, symlinks, downloads and URLs fetched on a caller's behalf.",
    moves: ["Find every place a caller-controlled name becomes a path or URL.", "Check normalisation happens before the containment test.", "Check extraction and copy code for traversal and link following."],
  },
  {
    id: "crypto-secrets", name: "Cryptography and secrets",
    focus: "Weak or misused primitives, predictable tokens, hard-coded or logged secrets, missing verification.",
    moves: ["Find where tokens, keys and nonces are made and compared.", "Check comparison is constant time and verification cannot be skipped.", "Trace where secrets are stored, logged or returned."],
  },
  {
    id: "business-logic", name: "Business logic",
    focus: "Rules that can be bent: ordering, races, replay, limits, state machines, price and quota arithmetic.",
    moves: ["Write down the intended state machine.", "Look for a step that can be repeated, reordered or skipped.", "Check arithmetic for sign, overflow and rounding abuse."],
  },
  {
    id: "feature-abuse", name: "Feature abuse and data leakage",
    focus: "Legitimate features turned against the owner: export, share, preview, webhook, search and error output that reveal more than intended.",
    moves: ["List features that move data out of a trust boundary.", "Check what an error or debug path prints.", "Check who can trigger outbound requests or messages."],
  },
  {
    id: "chains", name: "Chained vulnerabilities and trust boundaries",
    focus: "Two weak spots that together cross a boundary neither crosses alone.",
    moves: ["Draw the trust boundaries from the architecture notes.", "For each low-severity candidate ask what it unlocks.", "Prefer chains that end in code execution or data of another user."],
  },
  {
    id: "wildcard", name: "Wildcard",
    focus: "Anything that looks wrong and fits no other class.",
    moves: ["Read the riskiest unit slowly instead of searching by pattern.", "Follow surprising code: unusual parsers, hand-rolled auth, dynamic loading."],
  },
  {
    id: "obvious", name: "Obvious things",
    focus: "Plain mistakes that are easy to overlook: debug flags left on, default credentials, disabled verification, permissive CORS.",
    moves: ["Grep configuration and startup code for toggles that weaken security.", "Check defaults of every listener and every optional check."],
  },
];
