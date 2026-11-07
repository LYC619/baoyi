/** Render without Vue so a failed bootstrap still has a usable recovery action. */
export function showBootError(error: unknown): void {
  const root = document.getElementById('app')
  if (!root) return
  root.innerHTML = `<div class="boot-error" style="height:100vh;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:12px;padding:32px;text-align:center">
    <h1>抱一没能启动</h1><p>读取应用设置或资料时出错：</p>
    <pre style="max-width:640px;white-space:pre-wrap;overflow-wrap:anywhere;text-align:left"></pre>
    <p data-directory>正在读取数据目录…</p><p>可以重试；仍失败时，请保留资料库并查看启动日志。</p>
    <button type="button" class="btn btn--primary">重试</button></div>`
  root.querySelector('pre')!.textContent = error instanceof Error ? error.message : String(error)
  const directory = root.querySelector('[data-directory]')!
  const retry = root.querySelector('button')!
  retry.addEventListener('click', () => { retry.disabled = true; retry.textContent = '正在重试…'; window.location.reload() })
  void Promise.resolve().then(() => window.baoyi?.app?.info()).then(info => {
    if (directory.isConnected) directory.textContent = info?.dataDirectory ? '数据目录：' + info.dataDirectory : '当前数据目录暂时无法读取。'
  }).catch(() => { if (directory.isConnected) directory.textContent = '当前数据目录暂时无法读取。' })
}
