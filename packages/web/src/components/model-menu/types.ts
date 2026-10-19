export type AgentMode = "max" | "standard" | "lite" | "flex";
export type EffortLevel = "medium" | "high" | "extra" | "ultra";

export interface ModelMenuItem {
  mode: AgentMode;
  title: string;
  titleAr: string;
  description: string;
  descriptionAr: string;
}

export interface FlexModel {
  providerId: string;
  flexCredentialUid: string;
  name: string;
}
