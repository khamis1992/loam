import { getApiHeaders } from '@/services/rpc';

export async function workspaceSlidesFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = await getApiHeaders();
  return fetch(input, {
    ...init,
    headers: {
      ...headers,
      ...(init?.headers ?? {}),
    },
  });
}
