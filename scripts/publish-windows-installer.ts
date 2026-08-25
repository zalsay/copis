#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { FunctionalModuleCosSdkClient } from './functional-module-cos-client'
import {
  createFunctionalModuleCosClient,
  parseFunctionalModuleCosBucketUrl,
  type FunctionalModuleCosUploadProgress,
} from './functional-module-cos-client'
import type { FunctionalModuleObjectClient } from './functional-module-publisher'

interface CosSdkConstructor {
  new (options: Record<string, string | number>): FunctionalModuleCosSdkClient
}

const DEFAULT_COS_UPLOAD_TIMEOUT_MS = 30 * 60 * 1000
const MIN_COS_UPLOAD_TIMEOUT_MS = 30 * 1000
const MAX_COS_UPLOAD_TIMEOUT_MS = 2 * 60 * 60 * 1000

export const DEFAULT_WINDOWS_INSTALLER_OBJECT_KEY =
  'copis/downloads/stable/win32-x64/Copis-Setup.exe'

export interface WindowsInstallerUploadInput {
  filePath: string
  objectKey: string
  publicBaseUrl: string
  version?: string
}

export interface WindowsInstallerUpload {
  key: string
  url: string
  filename: string
  body: Buffer
  size: number
  sha256: string
  version?: string
}

export function buildWindowsInstallerUpload(input: WindowsInstallerUploadInput): WindowsInstallerUpload {
  const filePath = resolve(input.filePath)
  let stats
  try {
    stats = statSync(filePath)
  } catch (error) {
    throw new Error(`Windows 安装程序不存在：${filePath}`, { cause: error })
  }
  if (!stats.isFile()) throw new Error(`Windows 安装程序不是文件：${filePath}`)

  const key = normalizeObjectKey(input.objectKey)
  const body = readFileSync(filePath)
  const publicBaseUrl = normalizePublicBaseUrl(input.publicBaseUrl)
  const version = input.version?.trim()
  const filename = basename(key)
  return {
    key,
    url: `${publicBaseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`,
    filename,
    body,
    size: body.byteLength,
    sha256: sha256(body),
    ...(version ? { version } : {}),
  }
}

export async function publishWindowsInstaller(
  upload: WindowsInstallerUpload,
  client: FunctionalModuleObjectClient,
): Promise<void> {
  await client.putObject({
    key: upload.key,
    body: upload.body,
    contentType: 'application/vnd.microsoft.portable-executable',
    cacheControl: 'no-cache, max-age=0, must-revalidate',
    contentDisposition: `attachment; filename="${upload.filename}"`,
    metadata: {
      sha256: upload.sha256,
      ...(upload.version ? { version: upload.version } : {}),
    },
    allowOverwrite: true,
  }, { allowOverwrite: true })

  const remote = await client.headObject({ key: upload.key })
  if (remote.size !== upload.size || remote.sha256?.toLowerCase() !== upload.sha256) {
    throw new Error(`Windows 安装程序远端校验失败：${upload.key}`)
  }
}

async function main(): Promise<void> {
  const filePath = requiredOption('--file', 'COPIS_WINDOWS_INSTALLER_FILE')
  const objectKey = getOption('--object-key')
    ?? process.env.COPIS_WINDOWS_INSTALLER_OBJECT_KEY?.trim()
    ?? DEFAULT_WINDOWS_INSTALLER_OBJECT_KEY
  const publicBaseUrl = requiredOption('--public-base-url', 'COS_PUBLIC_BASE_URL')
  const bucketUrl = requiredOption('--bucket-url', 'COS_BUCKET_URL')
  const bucketInfo = parseFunctionalModuleCosBucketUrl(bucketUrl)
  const bucket = getOption('--bucket') ?? process.env.COS_BUCKET?.trim() ?? bucketInfo.bucket
  const region = getOption('--region') ?? process.env.COS_REGION?.trim() ?? bucketInfo.region
  if (!bucket || !region) {
    throw new Error('无法从 COS_BUCKET_URL 推断 bucket/region，请设置 COS_BUCKET 和 COS_REGION')
  }

  const secretId = requiredEnv('COS_SECRET_ID')
  const secretKey = requiredEnv('COS_SECRET_KEY')
  const upload = buildWindowsInstallerUpload({
    filePath,
    objectKey,
    publicBaseUrl,
    version: getOption('--version') ?? process.env.COPIS_WINDOWS_INSTALLER_VERSION?.trim(),
  })

  const cosModule = await import('cos-nodejs-sdk-v5') as unknown as { default?: CosSdkConstructor }
  const Cos = cosModule.default
  if (!Cos) throw new Error('COS SDK 初始化失败')
  const timeoutMs = resolveCosUploadTimeoutMs()
  const cos = new Cos({ SecretId: secretId, SecretKey: secretKey, Region: region, Timeout: timeoutMs })
  let lastProgressLogAt = 0
  const client = createFunctionalModuleCosClient(cos, { bucket, region }, {
    onUploadProgress: (progress) => {
      const now = Date.now()
      if (progress.percent !== undefined && progress.percent >= 100 || now - lastProgressLogAt >= 5_000) {
        lastProgressLogAt = now
        console.log(`[publish-windows-installer] 上传进度：${formatUploadProgress(progress, upload.size)}`)
      }
    },
  })
  console.log(`[publish-windows-installer] 开始上传安装包：${formatBytes(upload.size)}，请求超时：${Math.round(timeoutMs / 1000)} 秒`)
  await publishWindowsInstaller(upload, client)

  console.log(`[publish-windows-installer] 已上传固定安装包：${upload.key}`)
  console.log(`[publish-windows-installer] 版本：${upload.version ?? '未指定'}，大小：${upload.size}，sha256：${upload.sha256}`)
  console.log(`[publish-windows-installer] 稳定下载地址：${upload.url}`)
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`缺少环境变量 ${name}`)
  return value
}

function resolveCosUploadTimeoutMs(): number {
  const raw = process.env.COPIS_COS_UPLOAD_TIMEOUT_MS?.trim()
  if (!raw) return DEFAULT_COS_UPLOAD_TIMEOUT_MS
  if (!/^\d+$/.test(raw)) throw new Error('COPIS_COS_UPLOAD_TIMEOUT_MS 必须是毫秒整数')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < MIN_COS_UPLOAD_TIMEOUT_MS || value > MAX_COS_UPLOAD_TIMEOUT_MS) {
    throw new Error(`COPIS_COS_UPLOAD_TIMEOUT_MS 必须在 ${MIN_COS_UPLOAD_TIMEOUT_MS} 到 ${MAX_COS_UPLOAD_TIMEOUT_MS} 之间`)
  }
  return value
}

function formatUploadProgress(progress: FunctionalModuleCosUploadProgress, fallbackTotal: number): string {
  const total = progress.total && progress.total > 0 ? progress.total : fallbackTotal
  const percent = progress.percent ?? (total > 0 ? progress.loaded / total * 100 : 0)
  const speed = progress.speed && progress.speed > 0 ? `，速度 ${formatBytes(progress.speed)}/s` : ''
  return `${percent.toFixed(1)}%（${formatBytes(progress.loaded)}/${formatBytes(total)}${speed}）`
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`
  return `${(value / 1024 ** 3).toFixed(2)} GB`
}

function requiredOption(option: string, envName: string): string {
  const value = getOption(option) ?? process.env[envName]?.trim()
  if (!value) throw new Error(`缺少 ${option} 或环境变量 ${envName}`)
  return value
}

function getOption(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value?.trim() || undefined
}

function normalizePublicBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  const url = new URL(trimmed)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('COS_PUBLIC_BASE_URL 必须是 HTTP(S) URL')
  }
  return trimmed
}

function normalizeObjectKey(value: string): string {
  const normalized = value.trim().replace(/^\/+/, '')
  const segments = normalized.split('/')
  if (!normalized || normalized.includes('\\') || normalized.includes('\0')
    || normalized.includes('?') || normalized.includes('#')
    || segments.some((segment) => segment === '.' || segment === '..'
      || !/^[A-Za-z0-9._-]+$/.test(segment))) {
    throw new Error(`Windows 安装程序 COS 对象 key 不合法：${value}`)
  }
  return normalized
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

if (import.meta.main) await main()
