import { useEffect, useRef, useState } from 'react';

/** 扫描动画播完前保留节点的时长（与 route-progress-sweep 时长匹配）。 */
const SWEEP_MS = 400;

/**
 * 路由顶部进度条（票 #60 T-A）：CSS 自实现，不引 react-top-loading-bar。
 *
 * 壳是声明式 router（BrowserRouter + useRoutes，票 46 架构），react-router
 * v7 的 in-flight 信号（useNavigation / useBlocker / useRouterState）只对
 * data router 开放，声明式模式拿不到 pending 状态；本组件以导航提交
 * （location.key 变化）为触发信号——每次切页播一段 0→100% 的完成扫描
 * （样式在 index.css），观感对齐 shadcn-admin 顶部加载条，不迁移路由架构。
 */
export function RouteProgress({ locationKey }: { locationKey: string | undefined }) {
  const [visible, setVisible] = useState(false);
  const isFirstKey = useRef(true);

  useEffect(() => {
    // 首次挂载不播（初始进入不算切页）。
    if (isFirstKey.current) {
      isFirstKey.current = false;
      return;
    }
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), SWEEP_MS);
    return () => window.clearTimeout(timer);
  }, [locationKey]);

  if (!visible) return null;
  return (
    // key 取 locationKey：连续导航时重挂节点让扫描动画重播。
    <div key={locationKey} data-testid="route-progress" aria-hidden="true" className="route-progress" />
  );
}
