import { getApiBase, getApiHeaders } from './rpc';

/**
 * W-U3 build-launcher client. Sends the brief to the two team engines through
 * the exact endpoints the legacy desktop UI and the Agent Studio info pane
 * already use:
 *  - POST /api/swarm/runs   { brief }              → { run: SwarmRunRef }
 *  - POST /api/realswarm/runs { goal, maxWorkers?…} → { run: SwarmRunRef }
 *
 * The app-builder engine needs no helper here: creating its project goes
 * through the existing `createAppProject` in `./appBuilderApi`
 * (POST /api/app-projects { title, description, flavor }).
 */

export interface SwarmRunRef {
  id: string;
  status?: string;
  brief?: string;
  goal?: string;
}

interface RunResponse {
  run?: { id?: string; status?: string; brief?: string; goal?: string };
  error?: string;
}

async function postRun(path: string, body: Record<string, unknown>): Promise<SwarmRunRef> {
  const res = await fetch(`${getApiBase()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(await getApiHeaders()) },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as RunResponse;
  if (!res.ok || !data.run?.id) {
    throw new Error(data.error ?? `status ${res.status}`);
  }
  return data.run as SwarmRunRef;
}

/** Full execution team (swarm engine). POST /api/swarm/runs. */
export function launchSwarmRun(brief: string): Promise<SwarmRunRef> {
  return postRun('/api/swarm/runs', { brief });
}

/** Self-organizing team (realswarm engine). POST /api/realswarm/runs. */
export function launchRealSwarmRun(goal: string): Promise<SwarmRunRef> {
  return postRun('/api/realswarm/runs', { goal });
}
