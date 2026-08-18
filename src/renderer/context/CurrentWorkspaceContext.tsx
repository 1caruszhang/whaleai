import { createContext, useContext } from "react";

import type { BrandWorkspace } from "@/api/brandWorkspaceClient";

/**
 * 当前品牌工作区的只读投影。Owner 仍是 App 的品牌状态；
 * 聊天消息里的 GEO 卡片（闸门交互宿主）通过它读取产品线等
 * 工作区事实，不反写权威状态。
 */
export const CurrentWorkspaceContext = createContext<BrandWorkspace | null>(
  null,
);

export function useCurrentWorkspace(): BrandWorkspace | null {
  return useContext(CurrentWorkspaceContext);
}
