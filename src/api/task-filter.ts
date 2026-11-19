/** Read-only filtering of already-authorized task cards. */
export function matchesTask(text: string, state: string, query: string, filter: string): boolean {
  return (!filter || state === filter) && text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}
