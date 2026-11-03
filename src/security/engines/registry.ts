export type EngineLicenseClass = "permissive" | "copyleft" | "review-required";

export interface EngineManifest {
  id: "mobsf" | "mobsfscan" | "frida" | "jadx" | "zap" | "nuclei" | "sqlmap" | "aflplusplus" | "jazzer";
  officialUrl: string;
  license: string;
  licenseClass: EngineLicenseClass;
  isolation: "external-process" | "external-service";
  commands: string[];
  executableEnv?: string;
  sha256Env?: string;
}

export const ENGINE_MANIFESTS: readonly EngineManifest[] = [
  { id: "mobsf", officialUrl: "https://github.com/MobSF/Mobile-Security-Framework-MobSF", license: "GPL-3.0", licenseClass: "copyleft", isolation: "external-service", commands: ["scan"] },
  { id: "mobsfscan", officialUrl: "https://github.com/MobSF/mobsfscan", license: "LGPL-3.0", licenseClass: "copyleft", isolation: "external-process", commands: ["scan"] },
  { id: "frida", officialUrl: "https://github.com/frida/frida", license: "NOASSERTION", licenseClass: "review-required", isolation: "external-service", commands: ["instrument"] },
  { id: "jadx", officialUrl: "https://github.com/skylot/jadx", license: "Apache-2.0", licenseClass: "permissive", isolation: "external-process", commands: ["decompile"], executableEnv: "LOAM_JADX_PATH", sha256Env: "LOAM_JADX_SHA256" },
  { id: "zap", officialUrl: "https://github.com/zaproxy/zaproxy", license: "Apache-2.0", licenseClass: "permissive", isolation: "external-process", commands: ["scan"] },
  { id: "nuclei", officialUrl: "https://github.com/projectdiscovery/nuclei", license: "MIT", licenseClass: "permissive", isolation: "external-process", commands: ["scan"] },
  { id: "sqlmap", officialUrl: "https://github.com/sqlmapproject/sqlmap", license: "NOASSERTION", licenseClass: "review-required", isolation: "external-process", commands: ["scan"] },
  { id: "aflplusplus", officialUrl: "https://github.com/AFLplusplus/AFLplusplus", license: "AGPL-3.0", licenseClass: "copyleft", isolation: "external-process", commands: ["fuzz"], executableEnv: "LOAM_AFL_PATH", sha256Env: "LOAM_AFL_SHA256" },
  { id: "jazzer", officialUrl: "https://github.com/CodeIntelligenceTesting/jazzer", license: "Apache-2.0", licenseClass: "permissive", isolation: "external-process", commands: ["fuzz"], executableEnv: "LOAM_JAZZER_PATH", sha256Env: "LOAM_JAZZER_SHA256" },
] as const;

export function engineManifest(id: string): EngineManifest {
  const manifest = ENGINE_MANIFESTS.find((item) => item.id === id);
  if (!manifest) throw new Error(`unknown engine ${id}`);
  return manifest;
}
