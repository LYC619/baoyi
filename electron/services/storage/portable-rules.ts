/**
 * 绿色版判据 —— 纯函数，不 import electron。
 *
 * 单独一个文件的理由和 `proxy-rules.ts` 一样：`portable.ts` 顶层要 `import { app }
 * from 'electron'`，那在纯 Node 下（selfcheck）加载即崩。判据本身是可判定的，
 * 就该能被自检直驱。
 *
 * **绿色版的定义**：解压即用、删掉文件夹就干净、数据跟着文件夹走。所以判据不是
 * 「是不是 zip 装的」（运行时看不出来），而是**exe 旁边有没有那个标记文件**。
 * 标记文件由打包时放进 zip，装机版（NSIS）不带 —— 于是同一份代码两种行为，
 * 不需要编译两回。
 */

/** 标记文件名。两个都认，`绿色版.txt` 给人看，`portable.txt` 是防中文出岔的兜底 */
export const PORTABLE_MARKERS = ['绿色版.txt', 'portable.txt'] as const

/** 绿色版模式下数据落在 exe 同级的这个目录里 */
export const PORTABLE_DATA_DIR = 'data'

export type PortableDecision =
  | { portable: false; reason: string }
  | { portable: true; dataDir: string }

/**
 * 决定这次启动要不要用绿色版模式，以及数据放哪。
 *
 * @param packaged   `app.isPackaged`。**开发时必须为 false** —— 开发时
 *                   `process.execPath` 指向 `node_modules` 里的 electron.exe，
 *                   真按它算会把数据写进 node_modules，而 `npm ci` 会把那儿清掉。
 * @param exeDir     exe 所在目录（`path.dirname(process.execPath)`）
 * @param exists     判断文件在不在（注入进来，方便自检不碰真盘）
 * @param writable   判断目录可写（注入同上）
 * @param join       路径拼接（注入同上，免得自检里依赖平台分隔符）
 */
export function decidePortable(
  packaged: boolean,
  exeDir: string,
  exists: (p: string) => boolean,
  writable: (dir: string) => boolean,
  join: (...parts: string[]) => string
): PortableDecision {
  if (!packaged) return { portable: false, reason: '开发模式，不认标记文件' }

  const marker = PORTABLE_MARKERS.find((m) => exists(join(exeDir, m)))
  if (!marker) return { portable: false, reason: '没有标记文件' }

  // 标记在但目录不可写：解压到 Program Files、或者从只读介质跑起来的情况。
  // **退回 %APPDATA% 而不是硬来** —— 硬来的结果是开库时抛一个 SQLITE_CANTOPEN，
  // 用户看到的是「应用打不开」，而真正的原因是装的位置不对。
  if (!writable(exeDir)) {
    return { portable: false, reason: `有标记（${marker}）但 ${exeDir} 不可写，退回默认目录` }
  }

  return { portable: true, dataDir: join(exeDir, PORTABLE_DATA_DIR) }
}
