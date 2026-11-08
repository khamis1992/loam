import { deleteAgent, setAgentArchived } from "./agents.js";
import { deleteSchedule, listSchedulesByAgent, setScheduleEnabled } from "./db.js";
import { stopWatcher } from "./fileWatchers.js";
import { deleteBinding, listBindings } from "./channels/router.js";
import { listGroups, removeGroupMember } from "./groupChats.js";
import { removeThread } from "./agentThreads.js";
import { deleteAgentIntegrationGrants } from "../tools/integrations.js";

export interface AgentTriggerCleanup {
  schedules: number;
  bindings: number;
  groups: number;
}

export function disableAgentTriggers(agentId: string, removeGroups = false): AgentTriggerCleanup {
  const summary = { schedules: 0, bindings: 0, groups: 0 };
  for (const schedule of listSchedulesByAgent(agentId)) {
    stopWatcher(schedule.id);
    if (setScheduleEnabled(schedule.id, false)) summary.schedules += 1;
  }
  for (const binding of listBindings(agentId)) {
    if (deleteBinding(binding.id)) summary.bindings += 1;
  }
  if (removeGroups) {
    for (const group of listGroups()) {
      if (!group.memberIds.includes(agentId)) continue;
      removeGroupMember(group.id, agentId);
      summary.groups += 1;
    }
  }
  return summary;
}

export function archiveAgentLifecycle(agentId: string): AgentTriggerCleanup {
  setAgentArchived(agentId, true);
  return disableAgentTriggers(agentId);
}

export function deleteAgentLifecycle(agentId: string): AgentTriggerCleanup | undefined {
  const agent = setAgentArchived(agentId, true);
  if (!agent) return undefined;
  const summary = disableAgentTriggers(agentId, true);
  for (const schedule of listSchedulesByAgent(agentId)) deleteSchedule(schedule.id);
  removeThread(agentId);
  deleteAgentIntegrationGrants(agentId);
  deleteAgent(agentId);
  return summary;
}
