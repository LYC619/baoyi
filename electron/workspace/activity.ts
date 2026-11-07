let pending = 0
export const workspaceBusy = () => pending > 0
export async function workspaceOperation<T>(action: () => Promise<T>): Promise<T> {
  if (pending) throw new Error('资料或项目正在处理，请稍后再试')
  pending++
  try { return await action() } finally { pending-- }
}
