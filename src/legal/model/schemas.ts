export type JsonSchema = {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean";
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
};

export const CLAIM_SUPPORT_SCHEMA: JsonSchema = {
  type: "object", required: ["claims"], additionalProperties: false,
  properties: {
    claims: {
      type: "array", minItems: 0,
      items: {
        type: "object", required: ["id", "text", "support", "reason"], additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 }, text: { type: "string", minLength: 1 },
          support: { enum: ["supported", "contradicted", "insufficient", "not_researched"] },
          authorityAvids: { type: "array", items: { type: "string" } },
          evidenceFactIds: { type: "array", items: { type: "string" } },
          exceptions: { type: "array", items: { type: "string" } },
          reason: { type: "string", minLength: 1 },
        },
      },
    },
  },
};

export const CONTRACT_ANALYSIS_SCHEMA: JsonSchema = {
  type: "object", required: ["findings"], additionalProperties: false,
  properties: {
    findings: {
      type: "array", minItems: 0,
      items: {
        type: "object", required: ["id", "severity", "titleAr", "explanationAr"], additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 }, clauseId: { type: "string" },
          ruleId: { type: "string", minLength: 1 }, severity: { enum: ["high", "medium", "low", "info"] },
          titleAr: { type: "string", minLength: 1 }, explanationAr: { type: "string", minLength: 1 },
          suggestionAr: { type: "string" },
        },
      },
    },
  },
};

export const CASE_THEORY_SCHEMA: JsonSchema = {
  type: "object", required: ["summary", "pleas", "primaryRequests", "alternativeRequests", "weaknesses", "unresolvedQuestions"], additionalProperties: false,
  properties: {
    summary: { type: "string", minLength: 1 },
    pleas: {
      type: "array", minItems: 0,
      items: {
        type: "object", required: ["id", "type", "title", "factIds", "researchQueries", "priority"], additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 }, type: { enum: ["procedural", "substantive", "evidentiary"] },
          title: { type: "string", minLength: 1 }, factIds: { type: "array", items: { type: "string" } },
          researchQueries: { type: "array", items: { type: "string" } }, priority: { type: "integer" },
        },
      },
    },
    primaryRequests: { type: "array", items: { type: "string" } },
    alternativeRequests: { type: "array", items: { type: "string" } },
    weaknesses: { type: "array", items: { type: "string" } },
    unresolvedQuestions: {
      type: "array", items: {
        type: "object", required: ["question", "material"], additionalProperties: false,
        properties: { question: { type: "string", minLength: 1 }, material: { type: "boolean" } },
      },
    },
  },
};

export const DEFENSE_DRAFT_SCHEMA: JsonSchema = {
  type: "object", required: ["markdown"], additionalProperties: false,
  properties: { markdown: { type: "string", minLength: 1 } },
};

export const ALLEGATION_MATRIX_SCHEMA: JsonSchema = {
  type: "object", required: ["entries", "unresolvedQuestions"], additionalProperties: false,
  properties: {
    entries: {
      type: "array", minItems: 0,
      items: {
        type: "object", required: ["id", "allegation", "kind", "disposition", "evidenceFactIds", "researchQueries", "response", "attachments", "needsClientDecision"], additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 }, allegation: { type: "string", minLength: 1 }, kind: { enum: ["factual", "legal", "request"] },
          disposition: { enum: ["admit", "deny", "no_knowledge", "explain", "procedural"] },
          evidenceFactIds: { type: "array", items: { type: "string" } }, researchQueries: { type: "array", items: { type: "string" } },
          response: { type: "string", minLength: 1 }, attachments: { type: "array", items: { type: "string" } }, needsClientDecision: { type: "boolean" },
        },
      },
    },
    unresolvedQuestions: {
      type: "array", items: {
        type: "object", required: ["question", "material"], additionalProperties: false,
        properties: { question: { type: "string", minLength: 1 }, material: { type: "boolean" } },
      },
    },
  },
};

export const ADVERSARIAL_SCHEMA: JsonSchema = {
  type: "object", required: ["findings"], additionalProperties: false,
  properties: {
    findings: {
      type: "array", minItems: 0,
      items: {
        type: "object", required: ["severity", "code", "message"], additionalProperties: false,
        properties: {
          severity: { enum: ["info", "warning", "high", "critical"] },
          code: { enum: ["unsupported_fact", "unsupported_claim", "missing_exception", "unintended_admission", "contradiction", "unenforceable_request", "stronger_defense", "coverage_gap"] },
          message: { type: "string", minLength: 1 },
          span: { type: "string" },
        },
      },
    },
  },
};
