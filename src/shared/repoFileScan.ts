// 仓库文件扫描工具：守卫测试（crossLanguageContractGuard / competitorRosterGuard）
// 的共享底座。两守卫此前各自持有逐字相同的副本，第三个守卫出现时会再抄一份——
// 收进本模块后「同口径」由同一实现直接保证。
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** 自仓库根下某目录递归收集命中 keep 的文件（跳过 node_modules/dist/.git）。 */
export function walkFiles(rootDir: string, keep: (file: string) => boolean): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (keep(entry.name)) out.push(path);
    }
  };
  visit(join(REPO_ROOT, rootDir));
  return out;
}

/** 规范化为仓库相对 POSIX 路径（守卫断言信息与引用比对用）。 */
export function repoRelative(path: string): string {
  return relative(REPO_ROOT, path).replace(/\\/g, "/");
}
