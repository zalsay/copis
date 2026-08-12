#!/usr/bin/env bun
/**
 * 发布 Electron 自动更新文件到 COS。
 *
 * 先上传版本化安装包和 blockmap，最后覆盖 latest*.yml，避免客户端读取到
 * 指向尚未上传文件的版本清单。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { FunctionalModuleCosSdkClient } from './functional-module-cos-client'
import { createFunctionalModuleCosClient, parseFunctionalModuleCosBucketUrl } from './functional-module-cos-client'
import type { FunctionalModuleObjectClient } from './functional-module-publisher'

export const DEFAULT_APP_UPDATES_OBJECT_PREFIX = 'copis/updates/stable'

interface CosSdkConstructor {
  new (options: Record<string, string>): FunctionalModuleCosSdkClient
}

export interface AppUpdateUpload {
  key: string
  path: string
  body: Buffer
  size: number
  sha256: string
  contentType: string
  cacheControl?: string
  allowOverwrite: boolean
}

export function buildAppUpdateUploads(directory: string, objectPrefix = DEFAULT_APP_UPDATES_OBJECT_PREFIX): AppUpdateUpload[] {
  const resolvedDirectory = resolve(directory)
  if (!existsSync(resolvedDirectory) || !statSync(resolvedDirectory).isDirectory()) {
    throw new Error(`Electron 更新产物目录不存在：${resolvedDirectory}`)
  }

  const prefix = normalizeObjectPrefix(objectPrefix)
  const manifests = readdirSync(resolvedDirectory)
    .filter((name) => /^latest(?:-[a-z0-9-]+)?\.yml$/i.test(name))
    .sort()
  if (manifests.length === 0) {
    throw new Error(`未找到 electron-builder 更新清单（latest*.yml）：${resolvedDirectory}`)
  }

  const uploadNames = new Set<string>()
  for (const manifest of manifests) {
    uploadNames.add(manifest)
    for (const asset of readUpdateManifestAssets(resolve(resolvedDirectory, manifest))) {
      const assetPath = resolve(resolvedDirectory, asset)
      if (!assetPath.startsWith(`${resolvedDirectory}/`) || !existsSync(assetPath) || !statSync(assetPath).isFile()) {
        throw new Error(`更新清单引用的文件不存在：${manifest} -> ${asset}`)
      }
      uploadNames.add(asset)
      const blockmap = `${asset}.blockmap`
      if (existsSync(resolve(resolvedDirectory, blockmap))) uploadNames.add(blockmap)
    }
  }

  const uploads = [...uploadNames].map((name) => buildUpload(resolvedDirectory, prefix, name))
  return uploads.sort((left, right) => Number(left.key.endsWith('.yml')) - Number(right.key.endsWith('.yml')))
}

export async function publishAppUpdates(
  uploads: readonly AppUpdateUpload[],
  client: FunctionalModuleObjectClient,
): Promise<void> {
  for (const upload of uploads) {
    await client.putObject({
      key: upload.key,
      body: upload.body,
      contentType: upload.contentType,
      metadata: { sha256: upload.sha256 },
      ...(upload.cacheControl ? { cacheControl: upload.cacheControl } : {}),
      ...(upload.allowOverwrite ? { allowOverwrite: true } : {}),
    }, { allowOverwrite: upload.allowOverwrite })
    const remote = await client.headObject({ key: upload.key })
    if (remote.size !== upload.size || remote.sha256?.toLowerCase() !== upload.sha256) {
      throw new Error(`COS 自动更新文件校验失败：${upload.key}`)
    }
  }
}

function buildUpload(directory: string, prefix: string, name: string): AppUpdateUpload {
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new Error(`更新文件名不合法：${name}`)
  }
  const path = resolve(directory, name)
  const body = readFileSync(path)
  const isManifest = name.endsWith('.yml')
  return {
    key: `${prefix}/${name}`,
    path,
    body,
    size: body.byteLength,
    sha256: sha256(body),
    contentType: isManifest ? 'application/x-yaml' : 'application/octet-stream',
    ...(isManifest ? { cacheControl: 'no-cache, max-age=0, must-revalidate' } : { cacheControl: 'public, max-age=31536000, immutable' }),
    allowOverwrite: isManifest,
  }
}

function readUpdateManifestAssets(path: string): string[] {
  const names = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = /^\s*-?\s*(?:url|path):\s*(.*?)\s*$/.exec(line)
      const value = match?.[1]?.replace(/^['"]|['"]$/g, '').trim()
      return value ? [value] : []
    })
  if (names.length === 0) throw new Error(`更新清单未包含安装包：${basename(path)}`)
  return [...new Set(names)]
}

function normalizeObjectPrefix(value: string): string {
  const normalized = value.trim().replace(/^\/+|\/+$/g, '')
  if (!normalized || normalized.includes('\\') || normalized.split('/').some((part) => !/^[A-Za-z0-9._-]+$/.test(part))) {
    throw new Error(`COS 更新对象前缀不合法：${value}`)
  }
  return normalized
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function main(): Promise<void> {
  const directory = requiredOption('--directory', 'COPIS_APP_UPDATES_DIRECTORY')
  const objectPrefix = getOption('--prefix') ?? process.env.COPIS_APP_UPDATES_OBJECT_PREFIX ?? DEFAULT_APP_UPDATES_OBJECT_PREFIX
  const bucketInfo = parseFunctionalModuleCosBucketUrl(requiredOption('--bucket-url', 'COS_BUCKET_URL'))
  const bucket = getOption('--bucket') ?? process.env.COS_BUCKET?.trim() ?? bucketInfo.bucket
  const region = getOption('--region') ?? process.env.COS_REGION?.trim() ?? bucketInfo.region
  if (!bucket || !region) throw new Error('无法从 COS_BUCKET_URL 推断 bucket/region，请设置 COS_BUCKET 和 COS_REGION')

  const cosModule = await import('cos-nodejs-sdk-v5') as unknown as { default?: CosSdkConstructor }
  if (!cosModule.default) throw new Error('COS SDK 初始化失败')
  const client = createFunctionalModuleCosClient(
    new cosModule.default({ SecretId: requiredEnv('COS_SECRET_ID'), SecretKey: requiredEnv('COS_SECRET_KEY'), Region: region }),
    { bucket, region },
  )
  const uploads = buildAppUpdateUploads(directory, objectPrefix)
  await publishAppUpdates(uploads, client)
  console.log(`[publish-app-updates] 已发布 ${uploads.length} 个自动更新文件到 ${objectPrefix}`)
  for (const upload of uploads) console.log(`[publish-app-updates] ${upload.key} (${upload.size} bytes)`)
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`缺少环境变量 ${name}`)
  return value
}

function requiredOption(option: string, environmentName: string): string {
  const value = getOption(option) ?? process.env[environmentName]?.trim()
  if (!value) throw new Error(`缺少 ${option} 或环境变量 ${environmentName}`)
  return value
}

function getOption(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1]?.trim() || undefined : undefined
}

if (import.meta.main) await main()
