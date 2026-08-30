# parser/ 的来源

这个目录是 [scttcper/video-filename-parser](https://github.com/scttcper/video-filename-parser)
的移植，**MIT 许可**，版权归 Scott Cooper。许可证原文见该项目的 `LICENSE`。

它是 Radarr / Sonarr 那套发布名解析逻辑的 TypeScript 实现，一张在真实片库上
跑了多年的正则表。v0.7 计划里把它列为 1 号参考并注明「MIT 可直接抄」，
所以这里是照搬而不是重写 —— 手抄 285 条正则只会抄错，而抄错的那一条要等到
用户某个文件识别错了才会暴露。

## 相对原版改了什么

只改了两处，都是为了能在本项目里跑起来，没有改任何解析逻辑：

1. **import 后缀 `.js` -> `.ts`**。本项目的自检和几个脚本用
   `node --experimental-strip-types` 直接跑 TS，它按真实文件名解析模块，
   `.js` 找不到文件。这也是本项目自己的约定（见 v0.7 计划的硬约束）。

2. **`export enum X` -> `export const X = {...} as const` + 同名联合类型**。
   `--experimental-strip-types` 是「只抹类型」模式，enum 有运行时语义抹不掉，
   会直接报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。转换后 `X.FOO` 的值用法和
   `codec?: X` 的类型用法都还在，调用方一行没动。

## 不要直接用这一层

标题提取对中文是坏的（JS 正则的 `\W` 把 CJK 当非单词字符，季集模式里的
`[-_\W]+` 会把中文标题吃掉，只剩第一个字）。走 `../filename.ts` ——
那一层用上游取技术事实和季集号，标题自己算。理由写在那个文件的头注释里。

## 另外两个参考项目

- **anitomy**（MIT）：番剧命名是另一套语法。当前 `filename.ts` 用绝对集号那条
  路径覆盖了常见的番剧命名，够用。真需要更细的番剧解析时从这里取。
- **guessit**（LGPL）：**只当规格和语料读，不抄代码**。
  `tests/*.yml` 是它的 ground truth 语料，自检直接拿来跑（见 selfcheck 的
  视频文件名解析一节）。LGPL 的代码一行都没进这个仓库。

jellyfin（GPL）和 MoviePilot（GPL）同样只当规格读。
