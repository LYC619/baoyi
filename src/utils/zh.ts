import { SIMPLIFIED, TRADITIONAL } from './zh-table.ts'

// 一次建表，4105 个单字。搜索两边都过一遍同一个函数：库里的字段和用户输入的关键词，
// 繁体、简体、混着写都落到同一个简体串上再比较。日文汉字（體→体、國→国）顺带也覆盖到了
let table: Map<string, string> | null = null
export function simplifyZh(text: string): string {
  if (!table) {
    table = new Map()
    const from = [...TRADITIONAL], to = [...SIMPLIFIED]
    for (let i = 0; i < from.length; i++) table.set(from[i], to[i])
  }
  let out = ''
  for (const ch of text) out += table.get(ch) ?? ch
  return out
}

/** 搜索用的归一化：繁→简 + 小写。better-sqlite3 和 node:sqlite 都能把它注册成 SQL 函数 zh_key() */
export const zhSearchKey = (value: unknown): string => simplifyZh(String(value ?? '')).toLowerCase()
