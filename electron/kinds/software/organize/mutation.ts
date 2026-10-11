/** Main-process guard shared by sync, removal and directory writes across windows. */
let active = false
export async function withOrganizeMutation<T>(run: () => Promise<T>): Promise<T> {
  if (active) throw new Error('软件目录操作正在进行中，请稍后重试')
  active = true
  try { return await run() } finally { active = false }
}
