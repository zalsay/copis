import type {
  FunctionalModuleObjectClient,
  FunctionalModuleObjectUpload,
  FunctionalModulePutObjectOptions,
} from './functional-module-publisher'

export interface FunctionalModuleCosSdkClient {
  putObject(
    params: Record<string, unknown>,
    callback: (error: unknown, data: unknown) => void,
  ): void
  headObject(
    params: Record<string, unknown>,
    callback: (error: unknown, data: unknown) => void,
  ): void
}

export interface FunctionalModuleCosBucket {
  bucket: string
  region: string
}

export interface FunctionalModuleCosUploadProgress {
  loaded: number
  total?: number
  speed?: number
  percent?: number
}

export interface FunctionalModuleCosClientOptions {
  onUploadProgress?: (progress: FunctionalModuleCosUploadProgress) => void
}

export function parseFunctionalModuleCosBucketUrl(value: string): FunctionalModuleCosBucket {
  const url = new URL(value)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('COS_BUCKET_URL 必须是 HTTP(S) URL')
  }
  const parts = url.hostname.split('.')
  const cosIndex = parts.indexOf('cos')
  const bucket = parts[0]
  const region = cosIndex >= 0 ? parts[cosIndex + 1] : undefined
  return {
    bucket: bucket && cosIndex > 0 ? bucket : '',
    region: region ?? '',
  }
}

interface CosHeadObjectResponse {
  ContentLength?: string | number
  Metadata?: Record<string, unknown>
  headers?: Record<string, unknown>
}

export function createFunctionalModuleCosClient(
  sdk: FunctionalModuleCosSdkClient,
  bucket: FunctionalModuleCosBucket,
  clientOptions: FunctionalModuleCosClientOptions = {},
): FunctionalModuleObjectClient {
  const client: FunctionalModuleObjectClient = {
    putObject: async (input, putOptions: FunctionalModulePutObjectOptions = {}) => {
      const allowOverwrite = putOptions.allowOverwrite === true || input.allowOverwrite === true
      if (!allowOverwrite) {
        let existing: { size: number; sha256?: string } | undefined
        try {
          existing = await client.headObject({ key: input.key })
        } catch (error) {
          if (!isNotFoundError(error)) throw error
        }
        if (existing) {
          const expectedSha256 = input.metadata.sha256?.toLowerCase()
          if (existing.size === input.body.byteLength
            && expectedSha256
            && existing.sha256?.toLowerCase() === expectedSha256) {
            return
          }
          throw new Error(`COS 不可变对象已存在且内容不同: ${input.key}`)
        }
      }

      const params: Record<string, unknown> = {
        Bucket: bucket.bucket,
        Region: bucket.region,
        Key: input.key,
        Body: input.body,
        ContentLength: input.body.byteLength,
        ContentType: input.contentType,
        ...metadataHeaders(input),
      }
      if (input.cacheControl) params.CacheControl = input.cacheControl
      if (input.contentDisposition) params.ContentDisposition = input.contentDisposition
      if (!allowOverwrite) params['x-cos-forbid-overwrite'] = 'true'
      if (clientOptions.onUploadProgress) {
        params.onProgress = (value: unknown) => {
          if (!isRecord(value) || typeof value.loaded !== 'number') return
          clientOptions.onUploadProgress?.({
            loaded: value.loaded,
            ...(typeof value.total === 'number' ? { total: value.total } : {}),
            ...(typeof value.speed === 'number' ? { speed: value.speed } : {}),
            ...(typeof value.percent === 'number' ? { percent: value.percent } : {}),
          })
        }
      }
      await callCos(sdk.putObject.bind(sdk), params)
    },
    headObject: async (input) => {
      const response = await callCos<CosHeadObjectResponse>(sdk.headObject.bind(sdk), {
        Bucket: bucket.bucket,
        Region: bucket.region,
        Key: input.key,
      })
      const headers = response.headers ?? {}
      const size = Number(
        response.ContentLength
          ?? findHeader(headers, 'content-length')
          ?? 0,
      )
      const sha256 = findHeader(response.Metadata ?? {}, 'sha256')
        ?? findHeader(response.Metadata ?? {}, 'x-cos-meta-sha256')
        ?? findHeader(headers, 'x-cos-meta-sha256')
      return {
        size,
        ...(sha256 ? { sha256 } : {}),
      }
    },
  }
  return client
}

function metadataHeaders(input: FunctionalModuleObjectUpload): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input.metadata).map(([name, value]) => [
      name.toLowerCase().startsWith('x-cos-meta-') ? name : `x-cos-meta-${name}`,
      value,
    ]),
  )
}

function findHeader(headers: Record<string, unknown>, name: string): string | undefined {
  const expected = name.toLowerCase()
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === expected)
  return typeof entry?.[1] === 'string' || typeof entry?.[1] === 'number'
    ? String(entry[1])
    : undefined
}

function callCos<T = unknown>(
  operation: (
    params: Record<string, unknown>,
    callback: (error: unknown, data: unknown) => void,
  ) => void,
  params: Record<string, unknown>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    operation(params, (error, data) => {
      if (error) {
        reject(toCosError(error))
        return
      }
      resolve(data as T)
    })
  })
}

function isNotFoundError(error: unknown): boolean {
  if (!isRecord(error)) return false
  return error.statusCode === 404
    || error.code === 'NoSuchKey'
    || error.code === 'NotFound'
}

function toCosError(error: unknown): Error {
  if (error instanceof Error) return error
  if (isRecord(error)) {
    const message = typeof error.message === 'string' ? error.message : 'COS 请求失败'
    const result = new Error(message)
    Object.assign(result, error)
    return result
  }
  return new Error('COS 请求失败')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
