/**
 * 游戏的分类体系与内置标签池。
 *
 * 和软件那套（services/taxonomy.ts）刻意分开：分类「这件事」是公共的
 * （resource.category 那一列），但「开发工具 / 系统管理」是软件的格子，
 * 「RPG / 动作」是游戏的格子。两套名字混进同一个池子，识别 prompt 就会
 * 把一个调试器归进「RPG」—— 这不是假想，categories 和 tags 在 0.5 之前
 * 是全局单表，0.6 给它们加了 kind 一列就是为了挡这件事。
 */

import type { Category } from '../../../src/types'

/** 归不进任何分类时的落脚点。它也是分类表里真实存在的一条，不是特殊值 */
export const GAME_FALLBACK_CATEGORY = '其他'

/**
 * 按**玩法**分，粒度对齐软件那套的经验：格子少而满，比多而空好。
 * 6 + 1 个格子，每个都装得下十几个游戏，agent 挑错的机会才小。
 */
export const GAME_CATEGORIES: Category[] = [
  {
    id: 'game-rpg',
    name: 'RPG',
    description: '角色扮演、剧情驱动、养成升级：JRPG、CRPG、魂系、开放世界 RPG',
    icon: 'swords',
    sort_order: 1
  },
  {
    id: 'game-action',
    name: '动作',
    description: '动作、射击、格斗、平台跳跃、赛车：操作和反应是核心的那些',
    icon: 'crosshair',
    sort_order: 2
  },
  {
    id: 'game-strategy',
    name: '策略',
    description: '即时战略、回合战棋、塔防、卡牌构筑、4X',
    icon: 'grid-3x3',
    sort_order: 3
  },
  {
    id: 'game-simulation',
    name: '模拟',
    description: '经营模拟、生存建造、沙盒、载具模拟、种田',
    icon: 'factory',
    sort_order: 4
  },
  {
    id: 'game-adventure',
    name: '冒险',
    description: '解谜、视觉小说、点击式冒险、恐怖、叙事向',
    icon: 'compass',
    sort_order: 5
  },
  {
    id: 'game-indie',
    name: '独立',
    description: '玩法难以归进以上格子的独立作品、实验性小品',
    icon: 'sparkle',
    sort_order: 6
  },
  {
    id: 'game-other',
    name: GAME_FALLBACK_CATEGORY,
    description: '还没归类，或自建分类之前的临时存放',
    icon: 'inbox',
    sort_order: 7
  }
]

/**
 * 内置标签池。以 source='user' 落库，和用户手建的等价 —— 直接进池注入 prompt。
 *
 * 标签池空着的时候 agent 只能凭空造词，造出来的又不进池（source='ai'），
 * 于是每一轮都在造新词。给它一批通用的起点，收敛就有了着力处。
 * 刻意和分类正交：分类回答「这是什么玩法」，标签回答「它还有什么特征」。
 */
export const GAME_TAGS = [
  '魂系',
  '开放世界',
  'Roguelike',
  '像素',
  '多人',
  '联机',
  '单机',
  '汉化',
  '模拟器',
  '独立游戏',
  '高难度',
  '剧情向'
]
