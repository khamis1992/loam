/** Task ids must match the backend's own validation (`task_<token>`); calling
 *  /api/files with anything else returns HTTP 400 ("invalid task id"). Filter
 *  client-side so legacy or corrupt entries cannot spam the console with 400s. */
export function isTaskId(value: string | undefined): boolean {
  return typeof value === 'string' && /^task_[a-zA-Z0-9_-]+$/.test(value);
}
