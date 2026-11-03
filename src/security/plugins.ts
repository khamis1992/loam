import { createHmac, timingSafeEqual } from "node:crypto";

export interface ScenarioPack {
  id: string;
  controlId: string;
  title: string;
  method: "automated" | "manual";
  standard?: "MASVS" | "WSTG" | "AGENTIC";
  standardVersion?: string;
  ruleVersion?: string;
  negativeControl?: string;
  evidenceRequired?: string[];
  timeoutMs?: number;
  idempotent?: boolean;
}

export interface SecurityPluginManifest {
  version: 1;
  id: string;
  publisher: string;
  kind: "scenario-pack" | "validator";
  scopes: string[];
  scenarios?: ScenarioPack[];
  signature: string;
}

const canonical = (manifest: Omit<SecurityPluginManifest, "signature">): string => JSON.stringify(manifest);
const signature = (manifest: SecurityPluginManifest, key: Buffer): string => {
  const { signature: _signature, ...unsigned } = manifest;
  return createHmac("sha256", key).update(canonical(unsigned)).digest("hex");
};

export function signPlugin(manifest: Omit<SecurityPluginManifest, "signature">, key: Buffer): SecurityPluginManifest {
  return { ...manifest, signature: signature({ ...manifest, signature: "" }, key) };
}

export class SecurityPluginRegistry {
  private readonly plugins = new Map<string, SecurityPluginManifest>();

  constructor(private readonly key: Buffer, private readonly allowedScopes: string[]) {
    if (key.length !== 32) throw new Error("plugin signing key must be 32 bytes");
  }

  register(manifest: SecurityPluginManifest): void {
    if (manifest.version !== 1 || !/^[a-z0-9][a-z0-9_.-]{2,80}$/.test(manifest.id) || this.plugins.has(manifest.id)) throw new Error("invalid or duplicate plugin identity");
    if (!["scenario-pack", "validator"].includes(manifest.kind) || !manifest.publisher.trim()) throw new Error("invalid plugin contract");
    if (manifest.scopes.some((scope) => !this.allowedScopes.includes(scope))) throw new Error("plugin scope is not allowed");
    const actual = Buffer.from(manifest.signature ?? "", "hex");
    const expected = Buffer.from(signature(manifest, this.key), "hex");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("plugin signature mismatch");
    for (const scenario of manifest.scenarios ?? []) {
      if (!/^[a-z0-9][a-z0-9_.:-]{2,100}$/.test(scenario.id) || !scenario.controlId || !scenario.title.trim()) throw new Error("invalid scenario in plugin");
    }
    this.plugins.set(manifest.id, { ...manifest, scopes: [...manifest.scopes], scenarios: manifest.scenarios?.map((scenario) => ({ ...scenario })) });
  }

  get(id: string): SecurityPluginManifest {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error("plugin is not registered");
    return plugin;
  }

  list(): Array<Omit<SecurityPluginManifest, "signature">> {
    return [...this.plugins.values()].map(({ signature: _signature, ...plugin }) => plugin);
  }
}
