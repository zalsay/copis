import type {
  BrowserLocatorBundle,
  BrowserLocatorStrategy,
  BrowserWorkflowManifest,
  BrowserWorkflowStep,
  BrowserWorkflowVersion,
} from '@copis/shared'

export interface BrowserWorkflowValidationResult {
  valid: boolean
  errors: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown, field: string, errors: string[]): value is string {
  if (typeof value === 'string' && value.trim()) return true
  errors.push(`${field} 必须是非空字符串`)
  return false
}

function numberValue(value: unknown, field: string, errors: string[]): value is number {
  if (typeof value === 'number' && Number.isFinite(value)) return true
  errors.push(`${field} 必须是有限数字`)
  return false
}

function checkOrigin(value: unknown, field: string, errors: string[]): value is string {
  if (!stringValue(value, field, errors)) return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      errors.push(`${field} 只允许 HTTP(S) Origin`)
      return false
    }
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
      errors.push(`${field} 必须是 Origin，不得包含路径、凭据或查询参数`)
      return false
    }
    return true
  } catch {
    errors.push(`${field} 不是有效 Origin`)
    return false
  }
}

function checkPageUrl(value: unknown, field: string, errors: string[]): value is string {
  if (!stringValue(value, field, errors)) return false
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      errors.push(`${field} 只允许 HTTP(S) 地址`)
      return false
    }
    return true
  } catch {
    errors.push(`${field} 不是有效网页地址`)
    return false
  }
}

function checkPattern(value: unknown, field: string, errors: string[]): value is string {
  if (!stringValue(value, field, errors)) return false
  try {
    new RegExp(value)
    return true
  } catch {
    errors.push(`${field} 不是有效正则表达式`)
    return false
  }
}

function checkLocatorStrategy(value: unknown, field: string, errors: string[]): value is BrowserLocatorStrategy {
  if (!isRecord(value) || !stringValue(value.kind, `${field}.kind`, errors)) return false
  switch (value.kind) {
    case 'testId':
      return stringValue(value.attribute, `${field}.attribute`, errors)
        && stringValue(value.value, `${field}.value`, errors)
    case 'role':
      return stringValue(value.role, `${field}.role`, errors)
        && (value.name === undefined || stringValue(value.name, `${field}.name`, errors))
    case 'label':
    case 'name':
    case 'id':
    case 'css':
      return stringValue(value.value, `${field}.value`, errors)
    case 'text': {
      const valueValid = stringValue(value.value, `${field}.value`, errors)
      const exactValid = typeof value.exact === 'boolean'
      if (!exactValid) errors.push(`${field}.exact 必须是 boolean`)
      return valueValid && exactValid
    }
    default:
      errors.push(`${field}.kind 不受支持`)
      return false
  }
}

function checkLocator(value: unknown, field: string, errors: string[]): value is BrowserLocatorBundle {
  if (!isRecord(value)) {
    errors.push(`${field} 必须是对象`)
    return false
  }
  let valid = true
  const framePath = isRecord(value.framePath) ? value.framePath : undefined
  const frameIds = framePath?.frameIds
  const frameUrls = framePath?.frameUrls
  const frameNames = framePath?.frameNames
  const frameIdsValid = Boolean(frameIds && Array.isArray(frameIds) && frameIds.every((item) => typeof item === 'string' && item.length <= 256))
  const frameUrlsValid = frameUrls === undefined || (Array.isArray(frameUrls) && frameUrls.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 2048))
  const frameNamesValid = frameNames === undefined || (Array.isArray(frameNames) && frameNames.every((item) => typeof item === 'string' && item.length <= 256))
  const framePathLengthsValid = !Array.isArray(frameUrls) || !Array.isArray(frameNames) || frameUrls.length === frameNames.length
  if (!frameIdsValid || !frameUrlsValid || !frameNamesValid || !framePathLengthsValid) {
    errors.push(`${field}.framePath 无效`)
    valid = false
  }
  if (!Array.isArray(value.strategies) || value.strategies.length === 0) {
    errors.push(`${field}.strategies 不能为空`)
    valid = false
  } else {
    value.strategies.forEach((strategy, index) => {
      if (!checkLocatorStrategy(strategy, `${field}.strategies[${index}]`, errors)) valid = false
    })
  }
  if (!isRecord(value.fingerprint)) {
    errors.push(`${field}.fingerprint 无效`)
    valid = false
  }
  return valid
}

function checkWorkflowValue(value: unknown, field: string, errors: string[], variableKeys?: Set<string>): boolean {
  if (!isRecord(value) || (value.kind !== 'literal' && value.kind !== 'variable')) {
    errors.push(`${field} 的 kind 必须是 literal 或 variable`)
    return false
  }
  if (value.kind === 'literal') return typeof value.value === 'string'
  const variableKey = value.variableKey
  const valid = stringValue(variableKey, `${field}.variableKey`, errors)
  if (valid && variableKeys && !variableKeys.has(variableKey)) {
    errors.push(`${field}.variableKey 未声明`)
    return false
  }
  return valid
}

function checkOutcome(value: unknown, field: string, aliases: Set<string>, errors: string[]): boolean {
  if (value === undefined) return true
  if (!isRecord(value) || typeof value.type !== 'string') {
    errors.push(`${field} 无效`)
    return false
  }
  switch (value.type) {
    case 'navigation':
      return value.urlPattern === undefined || checkPattern(value.urlPattern, `${field}.urlPattern`, errors)
    case 'newTab': {
      const valid = stringValue(value.tabAlias, `${field}.tabAlias`, errors)
      if (valid && typeof value.tabAlias === 'string') aliases.add(value.tabAlias)
      return valid
    }
    case 'visible':
      return checkLocator(value.target, `${field}.target`, errors)
    default:
      errors.push(`${field}.type 不受支持`)
      return false
  }
}

function checkCondition(value: unknown, field: string, kind: 'wait' | 'assert', errors: string[]): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') {
    errors.push(`${field} 无效`)
    return false
  }
  switch (value.type) {
    case 'url':
      return checkPattern(value.pattern, `${field}.pattern`, errors)
    case 'text': {
      const textValid = stringValue(value.value, `${field}.value`, errors)
      if (kind === 'assert') {
        const exactValid = typeof value.exact === 'boolean'
        if (!exactValid) errors.push(`${field}.exact 必须是 boolean`)
        return textValid && exactValid
      }
      return textValid
    }
    case 'visible':
      return kind === 'wait'
        ? checkLocator(value.target, `${field}.target`, errors)
        : true
    case 'hidden':
      return kind === 'assert'
    default:
      errors.push(`${field}.type 不受支持`)
      return false
  }
}

function checkStep(
  value: unknown,
  index: number,
  aliases: Set<string>,
  origins: Set<string>,
  errors: string[],
  variableKeys: Set<string>,
): value is BrowserWorkflowStep {
  const field = `steps[${index}]`
  if (!isRecord(value)) {
    errors.push(`${field} 必须是对象`)
    return false
  }
  let valid = true
  if (!stringValue(value.id, `${field}.id`, errors)) valid = false
  if (typeof value.type !== 'string') {
    errors.push(`${field}.type 必须是字符串`)
    return false
  }
  if (!stringValue(value.tabAlias, `${field}.tabAlias`, errors)) valid = false
  else if (!aliases.has(value.tabAlias) && value.type !== 'openTab') errors.push(`${field}.tabAlias 未声明`)
  if (!checkOrigin(value.origin, `${field}.origin`, errors)) valid = false
  else origins.add(value.origin)
  if (value.urlPattern !== undefined && !checkPattern(value.urlPattern, `${field}.urlPattern`, errors)) valid = false
  if (value.timeoutMs !== undefined && (!numberValue(value.timeoutMs, `${field}.timeoutMs`, errors) || value.timeoutMs <= 0 || value.timeoutMs > 300_000)) {
    errors.push(`${field}.timeoutMs 必须在 1 到 300000 之间`)
    valid = false
  }

  switch (value.type) {
    case 'navigate': {
      const urlValid = checkPageUrl(value.url, `${field}.url`, errors)
      if (urlValid && typeof value.url === 'string' && new URL(value.url).origin !== value.origin) {
        errors.push(`${field}.origin 必须与 url 的 Origin 一致`)
        valid = false
      }
      break
    }
    case 'click':
      if (!checkLocator(value.target, `${field}.target`, errors)) valid = false
      if (!checkOutcome(value.expect, `${field}.expect`, aliases, errors)) valid = false
      break
    case 'fill':
      if (!checkLocator(value.target, `${field}.target`, errors)) valid = false
      if (!checkWorkflowValue(value.value, `${field}.value`, errors, variableKeys)) valid = false
      break
    case 'press':
      if (!stringValue(value.key, `${field}.key`, errors)) valid = false
      if (value.target !== undefined && !checkLocator(value.target, `${field}.target`, errors)) valid = false
      break
    case 'select':
      if (!checkLocator(value.target, `${field}.target`, errors)) valid = false
      if (!checkWorkflowValue(value.value, `${field}.value`, errors, variableKeys)) valid = false
      break
    case 'wait':
      if (!checkCondition(value.condition, `${field}.condition`, 'wait', errors)) valid = false
      break
    case 'assert':
      if (value.target !== undefined && !checkLocator(value.target, `${field}.target`, errors)) valid = false
      if (!checkCondition(value.condition, `${field}.condition`, 'assert', errors)) valid = false
      if (isRecord(value.condition) && ['visible', 'hidden'].includes(String(value.condition.type)) && value.target === undefined) {
        errors.push(`${field}.target 在 visible/hidden 断言中必填`)
        valid = false
      }
      break
    case 'openTab':
      if (!stringValue(value.newTabAlias, `${field}.newTabAlias`, errors)) valid = false
      else aliases.add(value.newTabAlias)
      if (value.url !== undefined) {
        const urlValid = checkPageUrl(value.url, `${field}.url`, errors)
        if (urlValid && typeof value.url === 'string' && new URL(value.url).origin !== value.origin) {
          errors.push(`${field}.origin 必须与 url 的 Origin 一致`)
          valid = false
        }
      }
      break
    case 'switchTab':
    case 'closeTab':
      if (!stringValue(value.targetTabAlias, `${field}.targetTabAlias`, errors)) valid = false
      else if (!aliases.has(value.targetTabAlias)) errors.push(`${field}.targetTabAlias 未声明`)
      break
    case 'manual':
      if (!['password', 'otp', 'mfa', 'payment', 'file', 'captcha', 'confirmation', 'other'].includes(String(value.reason))) {
        errors.push(`${field}.reason 不受支持`)
        valid = false
      }
      if (!stringValue(value.instruction, `${field}.instruction`, errors)) valid = false
      break
    default:
      errors.push(`${field}.type 不受支持`)
      valid = false
  }
  return valid
}

export function validateBrowserWorkflowManifest(value: unknown): BrowserWorkflowValidationResult {
  const errors: string[] = []
  if (!isRecord(value)) return { valid: false, errors: ['manifest 必须是对象'] }
  if (value.schemaVersion !== 1) errors.push('manifest.schemaVersion 必须为 1')
  for (const field of ['id', 'workspaceId', 'name']) {
    stringValue(value[field], `manifest.${field}`, errors)
  }
  if (!stringValue(value.profileId, 'manifest.profileId', errors) || !/^[a-zA-Z0-9_-]+$/.test(String(value.profileId))) {
    errors.push('manifest.profileId 只能包含字母、数字、下划线或连字符')
  }
  if (!['draft', 'ready', 'disabled'].includes(String(value.status))) errors.push('manifest.status 无效')
  if (!numberValue(value.currentVersion, 'manifest.currentVersion', errors) || value.currentVersion < 1) errors.push('manifest.currentVersion 无效')
  if (!Array.isArray(value.allowedOrigins) || value.allowedOrigins.length === 0) errors.push('manifest.allowedOrigins 不能为空')
  else value.allowedOrigins.forEach((origin, index) => checkOrigin(origin, `manifest.allowedOrigins[${index}]`, errors))
  if (typeof value.unattendedAllowed !== 'boolean') errors.push('manifest.unattendedAllowed 必须是 boolean')
  for (const field of ['createdAt', 'updatedAt']) numberValue(value[field], `manifest.${field}`, errors)
  return { valid: errors.length === 0, errors }
}

export function validateBrowserWorkflowVersion(value: unknown): BrowserWorkflowValidationResult {
  const errors: string[] = []
  if (!isRecord(value)) return { valid: false, errors: ['version 必须是对象'] }
  if (value.schemaVersion !== 1) errors.push('version.schemaVersion 必须为 1')
  for (const field of ['workflowId', 'createdBySessionId']) stringValue(value[field], `version.${field}`, errors)
  if (!numberValue(value.version, 'version.version', errors) || value.version < 1) errors.push('version.version 无效')
  if (!numberValue(value.createdAt, 'version.createdAt', errors)) errors.push('version.createdAt 无效')
  if (!isRecord(value.start)) errors.push('version.start 无效')
  else {
    stringValue(value.start.tabAlias, 'version.start.tabAlias', errors)
    const startUrlValid = checkPageUrl(value.start.url, 'version.start.url', errors)
    const startOriginValid = checkOrigin(value.start.origin, 'version.start.origin', errors)
    if (startUrlValid && startOriginValid && typeof value.start.url === 'string' && new URL(value.start.url).origin !== value.start.origin) {
      errors.push('version.start.origin 必须与 start.url 的 Origin 一致')
    }
  }
  if (!Array.isArray(value.variables)) errors.push('version.variables 必须是数组')
  const variableKeys = new Set<string>()
  if (Array.isArray(value.variables)) {
    value.variables.forEach((variable, index) => {
      const field = `variables[${index}]`
      if (!isRecord(variable)) {
        errors.push(`${field} 必须是对象`)
        return
      }
      const variableKey = variable.key
      const keyValid = stringValue(variableKey, `${field}.key`, errors)
      if (keyValid) {
        if (variableKeys.has(variableKey)) errors.push(`${field}.key 重复`)
        variableKeys.add(variableKey)
      }
      stringValue(variable.label, `${field}.label`, errors)
      if (!['string', 'number', 'boolean', 'choice'].includes(String(variable.type))) errors.push(`${field}.type 无效`)
      if (typeof variable.required !== 'boolean') errors.push(`${field}.required 必须是 boolean`)
      if (variable.options !== undefined && (!Array.isArray(variable.options) || !variable.options.every((option) => typeof option === 'string'))) {
        errors.push(`${field}.options 无效`)
      }
      if (variable.sensitive !== undefined && typeof variable.sensitive !== 'boolean') errors.push(`${field}.sensitive 必须是 boolean`)
    })
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) errors.push('version.steps 不能为空')
  else {
    const aliases = new Set<string>()
    if (isRecord(value.start) && typeof value.start.tabAlias === 'string') aliases.add(value.start.tabAlias)
    const origins = new Set<string>()
    const stepIds = new Set<string>()
    value.steps.forEach((step, index) => {
      if (isRecord(step) && typeof step.id === 'string') {
        if (stepIds.has(step.id)) errors.push(`steps[${index}].id 重复`)
        stepIds.add(step.id)
      }
      checkStep(step, index, aliases, origins, errors, variableKeys)
      const next = Array.isArray(value.steps) ? value.steps[index + 1] : undefined
      if (
        isRecord(step)
        && step.type === 'click'
        && isRecord(next)
        && next.tabAlias === step.tabAlias
        && next.type === 'navigate'
      ) {
        errors.push(`steps[${index + 1}] 不应在 click 后再次执行 navigate，避免重复副作用`)
      }
      if (
        isRecord(step)
        && step.type === 'click'
        && isRecord(next)
        && next.type === 'openTab'
        && next.tabAlias === step.tabAlias
        && (!isRecord(step.expect) || step.expect.type !== 'newTab' || step.expect.tabAlias !== next.newTabAlias)
      ) {
        errors.push(`steps[${index + 1}] 必须由 click 的 newTab outcome 接管，避免重复创建页签`)
      }
    })
  }
  if (!isRecord(value.approval) || !['pending', 'approved', 'rejected'].includes(String(value.approval.status))) {
    errors.push('version.approval 无效')
  } else if (value.approval.draftHash !== undefined && (typeof value.approval.draftHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.approval.draftHash))) {
    errors.push('version.approval.draftHash 必须是 SHA-256 十六进制摘要')
  }
  return { valid: errors.length === 0, errors }
}

export function assertBrowserWorkflowManifest(value: unknown): BrowserWorkflowManifest {
  const result = validateBrowserWorkflowManifest(value)
  if (!result.valid) throw new Error(`Workflow manifest 无效：${result.errors.join('；')}`)
  return value as BrowserWorkflowManifest
}

export function assertBrowserWorkflowVersion(value: unknown): BrowserWorkflowVersion {
  const result = validateBrowserWorkflowVersion(value)
  if (!result.valid) throw new Error(`Workflow version 无效：${result.errors.join('；')}`)
  return value as BrowserWorkflowVersion
}
