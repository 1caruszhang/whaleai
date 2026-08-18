/**
 * 运营密码登录节流（票 10）：内存连续失败计数 + 递增延时
 * （第 n 次失败延时 min(n×unit, 20×unit)，成功即清零）。
 *
 * 取舍：单进程内存态——部署形态是 Docker 单容器（规格票 11），无跨实例
 * 共享需求；只延时不断锁，在线爆破被线性减速的同时运营不会被自己锁死。
 * 实例重建即清零，可接受（密码本身仍是唯一凭证，配套 HTTPS 传输）。
 */
export class AdminLoginThrottle {
  private consecutiveFailures = 0;

  constructor(
    private readonly unitMs: number,
    private readonly maxMs: number,
  ) {}

  /** 密码错误后调用：按连续失败次数同步递增延时后返回（再由调用方报 401）。 */
  async penalize(): Promise<void> {
    this.consecutiveFailures += 1;
    const delay = Math.min(this.consecutiveFailures * this.unitMs, this.maxMs);
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  }

  /** 密码正确后调用：清零连续失败计数。 */
  reset(): void {
    this.consecutiveFailures = 0;
  }
}
