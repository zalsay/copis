#!/usr/bin/env node
/**
 * preview.mjs — 设计大师轻量本地 HTTP 预览服务
 *
 * 用法：
 *   node preview.mjs [--port 5280] [--dir ./]
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname, resolve } from 'node:path'

function parseArgs(args) {
  const result = { port: 5280, dir: process.cwd() }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' || args[i] === '-p') result.port = parseInt(args[++i], 10) || 5280
    else if (args[i] === '--dir' || args[i] === '-d') result.dir = resolve(process.cwd(), args[++i])
  }
  return result
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4'
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const server = createServer((req, res) => {
    let reqPath = decodeURIComponent(req.url.split('?')[0])
    if (reqPath === '/' || reqPath === '') reqPath = '/index.html'

    let filePath = join(args.dir, reqPath)
    if (!existsSync(filePath) && existsSync(filePath + '.dc.html')) {
      filePath = filePath + '.dc.html'
    }

    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      const candidates = ['index.dc.html', 'index.html', 'design.dc.html']
      for (const c of candidates) {
        if (existsSync(join(filePath, c))) {
          filePath = join(filePath, c)
          break
        }
      }
    }

    if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('404 Not Found')
      return
    }

    const ext = extname(filePath).toLowerCase()
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'

    try {
      const content = readFileSync(filePath)
      res.writeHead(200, {
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*'
      })
      res.end(content)
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('500 Server Error: ' + err.message)
    }
  })

  server.listen(args.port, '127.0.0.1', () => {
    console.log(`[dashi-design] 预览服务已启动: http://127.0.0.1:${args.port}/`)
    console.log(`[dashi-design] 正在提供目录: ${args.dir}`)
    console.log('[dashi-design] 按 Ctrl+C 停止服务')
  })
}

main()
