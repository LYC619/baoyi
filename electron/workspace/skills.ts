import fs from "node:fs";
import path from "node:path";
import type { AgentTool } from "../services/agent/loop.ts";

const personalCatalog = [
  { name: "skill-profile", description: "技能事实建档、草案确认与成绩追加" },
  { name: "subscription", description: "订阅、授权、证件与保修登记" },
  { name: "body-status", description: "体重、睡眠等状态记录" },
  { name: "honors", description: "奖项、证书及经历登记" },
];

const documentCatalog = [
  { name: "novel-grouping", description: "小说与阅读资料题材分析、分组规划与方案确认" },
];

export const skillCatalog = personalCatalog
  .map((s) => `${s.name}：${s.description}`)
  .join("\n");

export const documentSkillCatalog = documentCatalog
  .map((s) => `${s.name}：${s.description}`)
  .join("\n");

export function loadSkillTool(root: string): AgentTool {
  return {
    name: "load_personal_skill",
    description: "按任务读取内置流程，开始个人建档前先调用。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", enum: personalCatalog.map((s) => s.name) },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async ({ name }) => {
      if (!personalCatalog.some((s) => s.name === name))
        throw new Error("未知的内置流程");
      return fs.readFileSync(path.join(root, name, "SKILL.md"), "utf8");
    },
  };
}

export function loadDocumentSkillTool(root: string): AgentTool {
  return {
    name: "load_document_skill",
    description: "按任务读取资料与小说整理的内置流程，开始小说题材分析与分组前先调用。",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", enum: documentCatalog.map((s) => s.name) },
      },
      required: ["name"],
      additionalProperties: false,
    },
    execute: async ({ name }) => {
      if (!documentCatalog.some((s) => s.name === name))
        throw new Error("未知的内置流程");
      return fs.readFileSync(path.join(root, name, "SKILL.md"), "utf8");
    },
  };
}
