import type { RuntimeRequest, RuntimeResponse } from './messages';

export async function sendRuntimeRequest<T>(request: RuntimeRequest): Promise<T> {
  const response = (await chrome.runtime.sendMessage(request)) as RuntimeResponse<T>;

  if (!response.ok) {
    throw new Error(response.error);
  }

  return response.data;
}
