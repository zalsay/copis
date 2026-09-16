/** 生产构建暂时禁用创造模式入口，开发环境保留以便联调 DSH。 */
export function shouldDisableCreationModeSwitch(isProduction: boolean): boolean {
  return isProduction
}

/** 创造模式切换入口是否禁用。 */
export const CREATION_MODE_SWITCH_DISABLED = shouldDisableCreationModeSwitch(import.meta.env.PROD)
