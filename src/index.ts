import { Plugin } from "@opencode/plugin"
import { createRelay, parseProxyAddress, probeProxy } from "./relay.ts"
import { Ocpp, readSettings } from "./rpc.ts"
import type { Settings, SettingsUpdate } from "./rpc.ts"

export default Plugin.define({
  id: "ocpp",
  async setup(ctx) {
    const stored = await ctx.storage.get("settings")
    let settings: Settings = stored === undefined ? { address: "", routing: false } : readSettings(stored)
    parseProxyAddress(settings.address)
    const relay = createRelay(() => settings)
    let updates = Promise.resolve()
    let disposed = false

    try {
      await ctx.provider.transform((editor) => {
        if (!settings.routing) return
        editor.update("opencode", (provider) => {
          provider.settings = { ...provider.settings, transport: "http" }
        })
      })

      await ctx.model.transform((editor) => {
        if (!settings.routing) return
        const defaults = editor.provider.get("opencode")?.provider.settings?.baseURL
        for (const candidate of editor.list("opencode")) {
          if (candidate.providerID !== "opencode") continue
          editor.update(candidate.providerID, candidate.id, (model) => {
            const upstream = model.settings?.baseURL === undefined ? defaults : model.settings.baseURL
            model.settings = { ...model.settings, baseURL: relay.url(upstream) }
            for (const variant of model.variants) {
              if (!variant.settings || !Object.hasOwn(variant.settings, "baseURL")) continue
              variant.settings = { ...variant.settings, baseURL: relay.url(variant.settings.baseURL) }
            }
          })
        }
      })

      await ctx.rpc.register(Ocpp, {
        get: async () => ({ ...settings }),
        update: async (input, context) => {
          const update = input as SettingsUpdate
          const pending = updates.then(async () => {
            context.signal.throwIfAborted()
            if (disposed) throw new Error("Proxy plugin has been unloaded")
            const next = { ...settings }
            if (update.address !== undefined) {
              try {
                parseProxyAddress(update.address)
              } catch {
                return context.error(
                  "invalid_address",
                  "Use host:port or an HTTP/HTTPS proxy URL, optionally with user:pass@ credentials.",
                  {},
                )
              }
              next.address = update.address.trim()
            }
            if (update.routing !== undefined) next.routing = update.routing
            const routingChanged = settings.routing !== next.routing
            try {
              await ctx.storage.set("settings", { ...next })
            } catch {
              return context.error("save_failed", "Could not save proxy settings.", {})
            }
            settings = next
            if (routingChanged) {
              try {
                // Provider reload also invalidates models and replays both transforms.
                await ctx.provider.reload()
              } catch {
                return context.error("save_failed", "Settings were saved, but the model catalog could not refresh.", {})
              }
            }
            return { ...settings }
          })
          updates = pending.then(() => undefined, () => undefined)
          return pending
        },
        probe: async (_input, context) => ({
          reachable: await probeProxy(settings.address, context.signal),
        }),
      })
    } catch (error) {
      await relay.stop()
      throw error
    }

    return async () => {
      disposed = true
      await updates
      await relay.stop()
    }
  },
})
