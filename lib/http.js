import http from 'node:http'
import https from 'node:https'

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) dsh-campus-net',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'Accept-Encoding': 'identity',
  'X-Requested-With': 'XMLHttpRequest',
}

function once(url, options) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch (error) {
      reject(error)
      return
    }
    const client = target.protocol === 'https:' ? https : http
    const headers = { ...DEFAULT_HEADERS, ...(options.headers || {}) }
    if (options.hostHeader) headers.Host = options.hostHeader
    const req = client.request(
      target,
      {
        method: options.method || 'GET',
        headers,
        timeout: options.timeoutMs || 8000,
        rejectUnauthorized: options.rejectUnauthorized !== false,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const buffer = Buffer.concat(chunks)
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            buffer,
            text: buffer.toString('utf8').replace(/^﻿/, ''),
          })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    if (options.body !== undefined && options.body !== null) req.write(options.body)
    req.end()
  })
}

/** 发一个 HTTP 请求；只跟随 GET 的重定向，POST 原样返回状态码，避免把凭据转去别的主机。 */
export async function request(url, options = {}) {
  let response = await once(url, options)
  let redirects = options.followRedirects ?? 3
  while (
    redirects > 0 &&
    response.status >= 301 &&
    response.status <= 308 &&
    response.headers.location &&
    (options.method || 'GET') === 'GET'
  ) {
    redirects -= 1
    const next = new URL(response.headers.location, url).toString()
    response = await once(next, { ...options, followRedirects: 0 })
  }
  return response
}

export async function requestJson(url, options = {}) {
  const response = await request(url, { ...options, headers: { 'Content-Type': 'application/json;charset=UTF-8', ...(options.headers || {}) } })
  const text = response.text.trim()
  try {
    return { status: response.status, data: JSON.parse(text) }
  } catch {
    return { status: response.status, data: null, text }
  }
}
