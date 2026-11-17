import { Socket } from "node:net"
import type { Settings } from "./rpc.ts"

const addressError = "Use host:port or an HTTP/HTTPS proxy URL, optionally with user:pass@ credentials."

export function parseProxyAddress(input: string): URL | undefined {
  const address = input.trim()
  if (!address) return undefined
  const qualified = /^[a-z][a-z\d+.-]*:\/\//i.test(address) ? address : `http://${address}`
  try {
    if (!/^[a-z][a-z\d+.-]*:\/\/[^/?#\\\s]+\/?$/i.test(qualified)) throw new Error()
    const url = new URL(qualified)
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      url.port === "0" ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error()
    }
    decodeURIComponent(url.username)
    decodeURIComponent(url.password)
    return url
  } catch {
    throw new Error(addressError)
  }
}

export function maskProxyAddress(address: string): string {
  const url = parseProxyAddress(address)
  if (!url) return "(not set)"
  if (url.username || url.password) {
    url.username = "***"
    url.password = "***"
  }
  const display = url.href.replace(/\/$/, "")
  return url.protocol === "http:" ? display.slice("http://".length) : display
}

export async function probeProxy(address: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted()
  let url: URL | undefined
  try {
    url = parseProxyAddress(address)
  } catch {
    return false
  }
  if (!url) return false
  const host = url.hostname.replace(/^\[|\]$/g, "")
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80))

  return new Promise<boolean>((resolve, reject) => {
    const socket = new Socket()
    let settled = false
    const finish = (reachable: boolean, cancelled = false) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      socket.removeListener("connect", connected)
      socket.removeListener("error", failed)
      socket.destroy()
      if (cancelled) reject(signal?.reason ?? new DOMException("Probe cancelled", "AbortError"))
      else resolve(reachable)
    }
    const connected = () => finish(true)
    const failed = () => finish(false)
    const abort = () => finish(false, true)
    const timer = setTimeout(failed, 3_000)
    socket.once("connect", connected)
    socket.once("error", failed)
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) return abort()
    try {
      socket.connect({ host, port })
    } catch {
      failed()
    }
  })
}

const hopByHop = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]

function endToEndHeaders(input: Headers): Headers {
  const headers = new Headers(input)
  for (const name of (headers.get("connection") ?? "").split(",")) {
    if (name.trim()) headers.delete(name.trim())
  }
  for (const name of hopByHop) headers.delete(name)
  return headers
}

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: { message: `ocpp: ${message}` } }, { status })
}

export function createRelay(getSettings: () => Readonly<Settings>) {
  const token = crypto.randomUUID()
  const active = new Set<AbortController>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    idleTimeout: 0,
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    async fetch(request) {
      const incoming = new URL(request.url)
      const prefix = `/${token}/`
      if (!incoming.pathname.startsWith(prefix)) return new Response("Not Found", { status: 404 })

      const encodedPath = incoming.pathname.slice(prefix.length)
      const separator = encodedPath.indexOf("/")
      const encoded = separator < 0 ? encodedPath : encodedPath.slice(0, separator)
      const suffix = separator < 0 ? "" : encodedPath.slice(separator)
      let upstream: URL
      try {
        if (!encoded || !/^[a-z\d_-]+$/i.test(encoded)) throw new Error()
        const original = Buffer.from(encoded, "base64url").toString("utf8")
        const base = new URL(original)
        if ((base.protocol !== "http:" && base.protocol !== "https:") || !base.hostname || base.hash) {
          throw new Error()
        }
        upstream = new URL(`${original.replace(/\/+$/, "")}${suffix}${incoming.search}`)
      } catch {
        return errorResponse("Missing or unsupported upstream endpoint.", 502)
      }

      const settings = getSettings()
      if (!settings.routing) return errorResponse("Proxy is off. Refresh the model catalog.", 503)
      let proxy: URL | undefined
      try {
        proxy = parseProxyAddress(settings.address)
      } catch {
        return errorResponse("The proxy address is invalid.", 503)
      }
      if (!proxy) return errorResponse("Set a proxy address before enabling the proxy.", 503)

      const controller = new AbortController()
      const abort = () => controller.abort(request.signal.reason)
      active.add(controller)
      request.signal.addEventListener("abort", abort, { once: true })
      if (request.signal.aborted) abort()
      const finish = () => {
        active.delete(controller)
        request.signal.removeEventListener("abort", abort)
      }

      try {
        const headers = endToEndHeaders(request.headers)
        // Fetch derives Host from the destination, including after redirects.
        headers.delete("host")
        const response = await fetch(upstream, {
          method: request.method,
          headers,
          body: request.body,
          signal: controller.signal,
          proxy: { url: proxy.href, respectNoProxy: false },
          decompress: false,
          redirect: "follow",
        })
        const responseHeaders = endToEndHeaders(response.headers)
        if (!response.body) {
          finish()
          return new Response(null, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
          })
        }

        const reader = response.body.getReader()
        const body = new ReadableStream<Uint8Array>({
          async pull(stream) {
            try {
              const chunk = await reader.read()
              if (chunk.done) {
                finish()
                reader.releaseLock()
                stream.close()
              } else {
                stream.enqueue(chunk.value)
              }
            } catch (error) {
              finish()
              reader.releaseLock()
              stream.error(error)
            }
          },
          async cancel(reason) {
            controller.abort(reason)
            try {
              await reader.cancel(reason)
            } finally {
              finish()
              reader.releaseLock()
            }
          },
        })
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
        })
      } catch {
        controller.abort()
        finish()
        return errorResponse("Proxy forwarding failed; no direct connection was attempted.", 502)
      }
    },
    error() {
      return errorResponse("Proxy relay failed.", 502)
    },
  })

  return {
    url(upstream: unknown): string {
      const encoded = Buffer.from(typeof upstream === "string" ? upstream : "").toString("base64url")
      return `${server.url.href}${token}/${encoded}`
    },
    async stop(): Promise<void> {
      for (const controller of active) controller.abort()
      await server.stop(true)
      active.clear()
    },
  }
}
