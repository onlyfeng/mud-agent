/**
 * 自动登录模式匹配。
 */

import type { MudConfig } from "./types";

interface LoginPattern {
  re: RegExp;
  field: "username" | "password" | "enter";
}

const LOGIN_PATTERNS: LoginPattern[] = [
  {
    re: /请输入.*角色名|请问.*名字|您的英文名字|your name|enter.*name|character name/i,
    field: "username",
  },
  { re: /请输入.*密码|password|passwd/i, field: "password" },
  { re: /按.*继续|press.*enter|press.*key|any key/i, field: "enter" },
];

const LOGIN_SUCCESS_RE =
  /欢迎回来|你进入了|你来到了|welcome back|entered the world|你出现在|登录成功|the land of|目前权限：|重新连线完毕/i;

export interface LoginAction {
  type: "send" | "success" | "none";
  value?: string;
  field?: string;
}

export function detectLoginAction(lines: string[], cfg: MudConfig, lastField?: string): LoginAction {
  const text = lines.join("\n");

  // 自定义登录步骤优先于内置 LOGIN_PATTERNS。
  // 服务器有时会在同一批数据中同时发送前置步骤（如编码选择）和用户名提示，
  // loginSequence 必须先于 LOGIN_PATTERNS 检查，否则会跳过前置步骤直接发用户名。
  for (const step of cfg.loginSequence || []) {
    if (typeof step.trigger !== "string" || step.trigger.length > 200) continue;
    let re: RegExp;
    try {
      re = new RegExp(step.trigger, "i");
    } catch {
      continue;
    }
    if (re.test(text)) {
      return { type: "send", value: `${step.send}\n`, field: "custom" };
    }
  }

  for (const { re, field } of LOGIN_PATTERNS) {
    // 已发过用户名则跳过用户名模式，避免「用户名:密码:」合并行被重复触发
    if (field === "username" && lastField === "username") continue;
    if (!re.test(text)) continue;
    const val =
      field === "username" ? cfg.credentials?.username : field === "password" ? cfg.credentials?.password : "";
    // 如果用户名或密码为空，不自动发送，让用户手动输入
    if (!val) {
      return { type: "none" };
    }
    return { type: "send", value: `${val}\n`, field };
  }

  if (LOGIN_SUCCESS_RE.test(text)) {
    return { type: "success" };
  }

  return { type: "none" };
}
