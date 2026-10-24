/** Ten companion domains. A domain is attached to a unit only when its whenToUse matches. */
export interface Domain {
  id: string;
  priority: boolean;
  whenToUse: string;
  coreDiscipline: string;
  classes: { name: string; text: string }[];
  universalMoves: string[];
  validationRules: string[];
}

const d = (
  slug: string, priority: boolean, whenToUse: string, coreDiscipline: string,
  classes: [string, string][], universalMoves: string[], validationRules: string[],
): Domain => ({
  id: `loam-audit/${slug}`, priority, whenToUse, coreDiscipline,
  classes: classes.map(([name, text]) => ({ name, text })), universalMoves, validationRules,
});

export const DOMAINS: Domain[] = [
  d("aiAndLlm", true, "The code builds prompts, calls models, runs tools on model output, or loads model files.",
    "Treat every model input and output as attacker-influenced text.",
    [["Prompt injection", "Untrusted text reaches a prompt that can call tools."], ["Tool over-reach", "A model-chosen argument becomes a path, command or URL without checks."], ["Unsafe model artifacts", "Pickle-style or executable model files are loaded."]],
    ["List every tool a model can call and what it can touch.", "Trace retrieved or fetched text into later prompts."],
    ["Show the untrusted text and the privileged call it can reach."]),
  d("clientSide", false, "The code renders HTML, handles URLs, cookies or browser storage.",
    "Ask what a script in the page origin could do.",
    [["DOM injection", "Untrusted strings reach innerHTML-style sinks."], ["Origin mixups", "postMessage and CORS accept any origin."]],
    ["Find every sink that writes markup.", "Check message and navigation handlers validate origin."],
    ["Name the sink and the source reaching it."]),
  d("cloudAndDeployment", false, "There are IaC files, container images, CI workflows or cloud SDK calls.",
    "Look at what the default deployment exposes.",
    [["Over-broad permissions", "Roles, buckets and ports wider than needed."], ["Pipeline trust", "CI steps run untrusted input with secrets."]],
    ["Read workflow triggers and permissions blocks.", "Check public exposure of storage and listeners."],
    ["Quote the file and setting, and state who can reach it."]),
  d("dataIsolation", false, "More than one tenant or user shares storage, caches or queues.",
    "Every read and write must be scoped by the caller's identity.",
    [["Missing scope", "A query lacks the tenant filter."], ["Shared caches", "Cache keys omit the identity."]],
    ["List data stores and the scoping column or key.", "Check background jobs carry identity."],
    ["Show a request from one tenant reaching another's data."]),
  d("desktopMobileIpc", true, "The code is an Electron, native or mobile app with IPC, deep links or local servers.",
    "Any local listener or message channel is reachable by other local software and sometimes by web pages.",
    [["Exposed bridges", "Renderer or web content can call privileged handlers."], ["Local listeners", "Loopback servers without auth or origin checks."], ["Deep links", "URL schemes trigger actions without confirmation."]],
    ["Enumerate IPC channels, handlers and their arguments.", "Check listeners bind to loopback and authenticate callers."],
    ["Show who can reach the channel and what the handler does with the argument."]),
  d("memorySafety", false, "The code is C, C++ or Rust with unsafe blocks.",
    "Follow sizes and lifetimes, not names.",
    [["Bounds errors", "Index or length from outside the buffer's real size."], ["Lifetime errors", "Use after free or double free."]],
    ["Check each copy against the destination size.", "Check integer arithmetic before allocation."],
    ["Give the size or lifetime that is violated."]),
  d("protocolsRpc", false, "The code parses wire formats or serves RPC, GraphQL or webhooks.",
    "Parsers are the boundary: assume hostile framing.",
    [["Parser confusion", "Two components read the same message differently."], ["Unauthenticated methods", "RPC methods missing the shared guard."]],
    ["List every method and message type.", "Check size and depth limits on decoding."],
    ["Show the message and the method that mishandles it."]),
  d("resourceExhaustion", false, "The code loops, allocates or spawns work from caller input.",
    "Report only exhaustion with a clear, cheap trigger and a real availability cost.",
    [["Unbounded work", "Caller input controls loop count or allocation with no cap."]],
    ["Look for missing caps on sizes, counts and timeouts."],
    ["Give the trigger and the cost ratio."]),
  d("supplyChainRelease", true, "There are package manifests, install scripts, build or release automation.",
    "Anything executed at install or build time runs with the builder's authority.",
    [["Install-time execution", "Lifecycle scripts or build hooks fetch and run code."], ["Unpinned inputs", "Dependencies and actions float on mutable references."], ["Release integrity", "Artifacts are published without verification."]],
    ["Read lifecycle scripts and workflow files first.", "Check pinning of dependencies and actions."],
    ["Quote the script or reference and state what runs and with which rights."]),
  d("webProtocolAuth", true, "The code handles sessions, tokens, OAuth, CSRF, redirects or SSO.",
    "Walk the whole flow and ask what each party proves to the next.",
    [["Token handling", "Missing audience, expiry or signature checks."], ["Redirect and state", "Open redirects and missing state or nonce."], ["Session lifecycle", "Fixation, no rotation, no revocation."]],
    ["Draw the login and refresh flow.", "Check every comparison of a token or state value."],
    ["State the missing proof and what an attacker gains."]),
];

export const PRIORITY_DOMAINS = DOMAINS.filter((x) => x.priority).map((x) => x.id);
