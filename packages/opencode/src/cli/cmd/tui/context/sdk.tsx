import { createOpencodeClient, type Event } from "@opencode-ai/sdk/v2"
import { createSimpleContext } from "./helper"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { batch, createSignal, onCleanup, onMount } from "solid-js"
import { Log } from "@/util/log"

export type EventSource = {
  on: (handler: (event: Event) => void) => () => void
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
  }) => {
    const abort = new AbortController()
    const [connected, setConnected] = createSignal(false)
    const sdk = createOpencodeClient({
      baseUrl: props.url,
      signal: abort.signal,
      directory: props.directory,
      fetch: props.fetch,
      headers: props.headers,
    })

    const emitter = createGlobalEmitter<{
      [key in Event["type"]]: Extract<Event, { type: key }>
    }>()

    let queue: Event[] = []
    let timer: Timer | undefined
    let last = 0

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      // Batch all event emissions so all store updates result in a single render
      batch(() => {
        for (const event of events) {
          emitter.emit(event.type, event)
        }
      })
    }

    const handleEvent = (event: Event) => {
      queue.push(event)
      const elapsed = Date.now() - last

      if (timer) return
      // If we just flushed recently (within 16ms), batch this with future events
      // Otherwise, process immediately to avoid latency
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    const log = Log.create({ service: "sdk" })

    onMount(() => {
      // If an event source is provided (local worker mode), use it directly
      if (props.events) {
        setConnected(true)
        const unsub = props.events.on(handleEvent)
        onCleanup(unsub)
        return
      }

      // Remote attach: use WebSocket for event streaming
      let ws: WebSocket | undefined
      let reconnectTimer: Timer | undefined

      const connect = () => {
        if (abort.signal.aborted) return

        const base = props.url.endsWith("/") ? props.url.slice(0, -1) : props.url
        const wsBase = base.replace(/^https/, "wss").replace(/^http/, "ws")
        const params = new URLSearchParams()
        if (props.directory) params.set("directory", props.directory)
        const wsUrl = params.size ? `${wsBase}/event?${params}` : `${wsBase}/event`

        ws = new WebSocket(wsUrl, {
          headers: props.headers,
        } as any)

        ws.onopen = () => {
          setConnected(true)
        }

        ws.onmessage = (event) => {
          try {
            handleEvent(JSON.parse(event.data as string) as Event)
          } catch (e) {
            log.warn("failed to parse ws event", { error: e instanceof Error ? e.message : e })
          }
        }

        ws.onclose = () => {
          setConnected(false)
          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()
          if (!abort.signal.aborted) {
            reconnectTimer = setTimeout(connect, 250)
          }
        }

        ws.onerror = () => {
          // onclose fires after onerror; reconnect is handled there
        }
      }

      connect()

      onCleanup(() => {
        clearTimeout(reconnectTimer)
        ws?.close()
      })
    })

    onCleanup(() => {
      abort.abort()
      if (timer) clearTimeout(timer)
    })

    return { client: sdk, event: emitter, url: props.url, connected }
  },
})
