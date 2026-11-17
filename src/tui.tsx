import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createRoot, createSignal, For, onCleanup, Show } from "solid-js"
import type { Accessor } from "solid-js"
import { maskProxyAddress } from "./relay.ts"
import { Ocpp, readProbe, readSettings } from "./rpc.ts"
import type { Settings } from "./rpc.ts"

interface DialogState {
  context: Plugin.Context
  settings: Accessor<Settings | undefined>
  selected: Accessor<number>
  reachable: Accessor<boolean | undefined>
  select: (row: number) => void
  activate: (row: number) => void
}

const dialogInset = 3
const innerInset = 1
const rows = ["Enable Proxy", "Proxy Address"] as const
const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

function SettingsDialog(props: DialogState) {
  const { context } = props
  const theme = context.theme.surface("dialog")
  const selectedBackground = theme.background.action.primary.focused
  const selectedText = theme.text.action.primary.focused
  const move = (direction: number) => props.select((props.selected() + direction + rows.length) % rows.length)

  const [frame, setFrame] = createSignal(0)
  createEffect(() => {
    if (props.reachable() !== undefined) return
    const timer = setInterval(() => setFrame((value) => (value + 1) % spinnerFrames.length), 80)
    onCleanup(() => clearInterval(timer))
  })

  context.keymap.layer(() => ({
    mode: "modal",
    priority: 100,
    commands: [
      { bind: "up,ctrl+p", run: () => move(-1) },
      { bind: "down,ctrl+n", run: () => move(1) },
      { bind: "return", run: () => props.activate(props.selected()) },
      { bind: "left,right", run: () => { if (props.selected() === 0) props.activate(0) } },
      { bind: "escape", run: () => context.ui.dialog.clear() },
    ],
  }))

  return (
    <box paddingLeft={dialogInset} paddingRight={dialogInset} paddingBottom={1} gap={1}>
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={innerInset}
        paddingRight={innerInset}
      >
        <text fg={theme.text.base}><b>OpenCode Proxy Plugin</b></text>
        <text fg={theme.text.muted} flexShrink={0} onMouseUp={() => context.ui.dialog.clear()}>esc</text>
      </box>
      <Show
        when={props.settings()}
        fallback={<text paddingLeft={innerInset} fg={theme.text.muted}>Loading proxy settings…</text>}
      >
        <box marginLeft={-dialogInset} marginRight={-dialogInset} paddingLeft={1} paddingRight={1}>
          <For each={rows}>
            {(label, index) => {
              const row = index()
              const isSelected = () => props.selected() === row
              const textColor = () => isSelected() ? selectedText : theme.text.base
              const valueColor = () => isSelected() ? selectedText : theme.text.muted
              const value = () => row === 0
                ? props.settings()?.routing ? "on" : "off"
                : maskProxyAddress(props.settings()?.address ?? "")

              return (
                <box
                  flexDirection="row"
                  height={1}
                  paddingLeft={dialogInset}
                  paddingRight={dialogInset}
                  gap={1}
                  backgroundColor={isSelected() ? selectedBackground : undefined}
                  onMouseMove={() => props.select(row)}
                  onMouseUp={(event) => {
                    if (event.button !== 0) return
                    props.activate(row)
                  }}
                >
                  <text fg={textColor()} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" wrapMode="none">
                    <Show when={isSelected()} fallback={label}><b>{label}</b></Show>
                  </text>
                  <box flexShrink={1} minWidth={0}>
                    <text fg={valueColor()} wrapMode="none" truncate minWidth={0}>{value()}</text>
                  </box>
                </box>
              )
            }}
          </For>
        </box>
      </Show>
      <box
        height={1}
        paddingLeft={innerInset}
        paddingRight={innerInset}
        flexShrink={0}
        flexDirection="row"
        justifyContent="space-between"
      >
        <text fg={theme.text.base} flexShrink={0} wrapMode="none">
          change<span style={{ fg: theme.text.muted }}> ←/→</span>
        </text>
        <Show
          when={props.reachable() !== undefined}
          fallback={<text fg={theme.text.muted} wrapMode="none">{spinnerFrames[frame()]} Checking</text>}
        >
          <text
            fg={props.reachable() ? theme.text.feedback.success.base : theme.text.feedback.error.base}
            wrapMode="none"
          >
            {props.reachable() ? "Reachable" : "Unreachable"}
          </text>
        </Show>
      </box>
    </box>
  )
}

function saveError(error: unknown): string {
  if (typeof error === "object" && error !== null && "type" in error) {
    if (error.type === "invalid_address") {
      return "Use host:port or an HTTP/HTTPS proxy URL, optionally with user:pass@ credentials."
    }
    if (error.type === "save_failed") return "Could not save proxy settings or refresh the model catalog."
  }
  return "Could not update proxy settings."
}

function openSettings(context: Plugin.Context): () => void {
  return createRoot((dispose) => {
    const [settings, setSettings] = createSignal<Settings>()
    const [selected, setSelected] = createSignal(0)
    const [reachable, setReachable] = createSignal<boolean>()
    let saving = false
    const lifetime = new AbortController()
    const location = context.location ?? context.data.location.default()
    const options = { location, signal: lifetime.signal }
    let probe: AbortController | undefined
    let closed = false
    let editing = false

    const close = () => {
      if (closed) return
      closed = true
      lifetime.abort()
      probe?.abort()
      dispose()
    }

    const notify = (message: string) => {
      context.ui.toast.show({ title: "OpenCode Proxy Plugin", message, variant: "error" })
    }

    const checkProxy = async () => {
      probe?.abort()
      const current = new AbortController()
      probe = current
      setReachable(undefined)
      try {
        const result = await context.client.rpc(Ocpp).probe(null, { location, signal: current.signal })
        if (!closed && !current.signal.aborted && probe === current) setReachable(readProbe(result))
      } catch {
        if (!closed && !current.signal.aborted && probe === current) notify("Could not check proxy reachability.")
      }
    }

    const toggle = async () => {
      const current = settings()
      if (closed || saving || !current) return
      saving = true
      try {
        const saved = await context.client.rpc(Ocpp).update({ routing: !current.routing }, options)
        if (!closed) setSettings(readSettings(saved))
      } catch (error) {
        if (!closed) notify(saveError(error))
      } finally {
        if (!closed) saving = false
      }
    }

    const editAddress = async () => {
      const current = settings()
      if (closed || saving || !current) return
      setSelected(1)
      saving = true
      editing = true
      let entered = current.address
      try {
        while (!closed) {
          const value = await context.ui.dialog.prompt({
            title: "Enter Proxy address",
            description: "host:port or user:pass@host:port; HTTP/HTTPS URLs accepted. Empty clears the address.",
            placeholder: "192.168.1.50:1080",
            value: entered,
          })
          if (closed || value === undefined) return
          entered = value
          try {
            const saved = await context.client.rpc(Ocpp).update({ address: entered }, options)
            if (closed) return
            setSettings(readSettings(saved))
            void checkProxy()
            return
          } catch (error) {
            if (closed) return
            const retry = await context.ui.dialog.confirm({
              title: "Proxy address not saved",
              message: saveError(error),
              label: { confirm: "Try again", cancel: "Cancel" },
            })
            if (closed || !retry) return
          }
        }
      } catch {
        if (!closed) notify("Could not open the proxy address dialog.")
      } finally {
        editing = false
        if (!closed) {
          saving = false
          show()
        }
      }
    }

    const state: DialogState = {
      context,
      settings,
      selected,
      reachable,
      select: (row) => { if (!closed) setSelected(row) },
      activate: (row) => { if (row === 0) void toggle(); else void editAddress() },
    }

    const show = () => {
      context.ui.dialog.show(() => <SettingsDialog {...state} />, () => { if (!editing) close() })
      context.ui.dialog.set({ size: "medium", centered: false })
    }

    show()
    void (async () => {
      try {
        const value = await context.client.rpc(Ocpp).get(null, options)
        if (closed) return
        setSettings(readSettings(value))
        void checkProxy()
      } catch {
        if (closed) return
        notify("Could not load proxy settings.")
        context.ui.dialog.clear()
        close()
      }
    })()
    return close
  })
}

export default Plugin.define({
  id: "ocpp",
  setup(context) {
    let close: (() => void) | undefined
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "ocpp.open",
        title: "Open proxy settings",
        group: "OpenCode Proxy Plugin",
        palette: true,
        slash: { name: "ocpp" },
        run: () => {
          close?.()
          close = openSettings(context)
        },
      }],
    }))
    return () => close?.()
  },
})
