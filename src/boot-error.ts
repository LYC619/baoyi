import { errorMessage } from '@/utils'
import { tr } from './i18n'
/** Render without Vue so a failed bootstrap still has a usable recovery action. */
export function showBootError(error: unknown): void {
  const root = document.getElementById('app')
  if (!root) return
  root.innerHTML = `<div class="boot-error" style="height:100vh;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:12px;padding:32px;text-align:center">
    <h1 data-heading></h1><p data-description></p>
    <pre style="max-width:640px;white-space:pre-wrap;overflow-wrap:anywhere;text-align:left"></pre>
    <p data-directory></p><p data-help></p>
    <button type="button" class="btn btn--primary"></button></div>`
  root.querySelector('[data-heading]')!.textContent = tr('抱一没能启动')
  root.querySelector('[data-description]')!.textContent = tr('读取应用设置或资料时出错：')
  root.querySelector('[data-help]')!.textContent = tr('可以重试；仍失败时，请保留资料库并查看启动日志。')
  root.querySelector('pre')!.textContent = errorMessage(error)
  const directory = root.querySelector('[data-directory]')!
  const retry = root.querySelector('button')!
  directory.textContent = tr('正在读取数据目录…')
  retry.textContent = tr('重试')
  retry.addEventListener('click', () => { retry.disabled = true; retry.textContent = tr('正在重试…'); window.location.reload() })
  const readInfo = window.baoyi?.app?.info
  if (!readInfo) {
    directory.textContent = tr('当前数据目录暂时无法读取。')
    return
  }
  void readInfo().then(info => {
    if (directory.isConnected) directory.textContent = info.dataDirectory ? tr('数据目录：') + info.dataDirectory : tr('当前数据目录暂时无法读取。')
  }).catch(() => { if (directory.isConnected) directory.textContent = tr('当前数据目录暂时无法读取。') })
}
