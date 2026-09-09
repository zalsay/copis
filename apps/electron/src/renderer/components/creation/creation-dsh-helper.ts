/**
 * 判断启动错误是否由于缺少/未安装 dsh 功能模块引起。
 */
export function isDshModuleMissingError(error?: string | null): boolean {
  if (!error) return false
  return /未找到.*激活.*(dsh|创造模式)|(dsh|创造模式).*未安装|未安装.*(dsh|创造模式)|缺少.*(dsh|创造模式)/i.test(error)
}
