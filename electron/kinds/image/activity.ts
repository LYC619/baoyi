let pending = 0
export const imageLibraryBusy = () => pending > 0
export async function imageOperation<T>(action: () => Promise<T>): Promise<T> {
  pending++
  try { return await action() } finally { pending-- }
}
