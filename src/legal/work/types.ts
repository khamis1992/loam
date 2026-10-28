export type MatterWorkKind = "task" | "deadline" | "hearing" | "filing";
export type MatterWorkStatus = "pending" | "in_progress" | "done" | "cancelled";

export interface MatterWorkItem {
  id: string;
  matterId: string;
  kind: MatterWorkKind;
  title: string;
  status: MatterWorkStatus;
  dueAt: string | null;
  assignee: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type NewMatterWorkItem = Omit<MatterWorkItem, "id" | "matterId" | "createdAt" | "updatedAt" | "completedAt">;
export type MatterWorkPatch = Partial<Omit<MatterWorkItem, "id" | "matterId" | "createdAt" | "updatedAt" | "completedAt">>;

export interface MatterWorkReport {
  total: number;
  pending: number;
  inProgress: number;
  done: number;
  cancelled: number;
  overdue: number;
  nextDueAt: string | null;
}
