# Implementation Plan: OpenCode Proxy Plugin (`ocpp`)

## Goal and Scope

Provide two settings that send the built-in `opencode` provider's model requests through a configured HTTP proxy. Support ordinary HTTP/HTTPS proxy addresses with optional username/password credentials.

- **Routing** defaults to `off`.
- **Address** defaults to unset. Saving Address does not change Routing.
- Routing on affects only the exact provider ID `opencode`; other providers keep their existing connections.
- Routing off leaves provider connections unchanged. Direct connections assume no independent process-wide proxy configuration.
- A failed proxy produces an error, never a direct fallback.
- Use public OpenCode V2 APIs and Bun networking. The plugin configures a proxy; it does not implement a proxy protocol or manage proxy services.

## Package Structure

Publish TypeScript source with these package exports:

```json
{
  "exports": {
    ".": "./src/index.ts",
    "./tui": "./src/tui.tsx"
  },
  "files": ["src"]
}
```

- **`src/index.ts`**: Server definition with stable ID `ocpp`, persisted settings, RPC handlers, and catalog transforms.
- **`src/rpc.ts`**: Internal contract shared by the server and TUI.
- **`src/relay.ts`**: Address parsing, TCP probing, and a private streaming relay.
- **`src/tui.tsx`**: `/ocpp` command and its settings dialog.

Include typechecking and dependencies compatible with the supported OpenCode/Bun release. Declare OpenTUI and Solid peers for the settings component. OpenCode loads the source entrypoints directly.

## Settings and RPC

Store `{ address: string, routing: boolean }` under one plugin-scoped `ctx.storage` key, defaulting to `{ address: "", routing: false }`. The server owns the settings; the TUI owns only dialog state.

Define three RPC methods through `@opencode/plugin/rpc`, using JSON Schema:

- **`get()`** returns current settings.
- **`update({ address?: string, routing?: boolean })`** validates, saves, and returns settings.
- **`probe()`** returns `{ reachable: boolean }` for the configured address.

Target the active OpenCode server location through the existing client. Serialize settings updates so concurrent saves do not overwrite unrelated fields. Refresh the provider/model catalogs when Routing changes; Address changes are used by the relay on subsequent requests. Keep probe results transient and independent of Routing.

## Address Parsing

- Trim input; an empty string represents an unset address.
- Prepend `http://` when no scheme is supplied, then parse with `URL`.
- Accept `http:` and `https:` with a hostname, including bracketed IPv6 and optional URL credentials.
- Use the parsed port or the scheme's default: 80 for HTTP and 443 for HTTPS.
- Reject malformed addresses, unsupported schemes, non-root paths, queries, and fragments.
- Follow standard URL percent-encoding rules for credentials. Mask credentials in the settings row and omit them from diagnostics.

## TCP Reachability Probe

Use `node:net` as supported by Bun to connect to the proxy's hostname and effective port. Remove IPv6 URL brackets before supplying a socket hostname.

- Return `false` immediately for an unset or invalid address.
- Apply a three-second overall deadline, including DNS resolution.
- Return `true` when connected and immediately destroy the socket.
- Return `false` on refusal, DNS failure, timeout, or another connection error.
- Clean up the socket, timer, and listeners on completion or cancellation. Cancelled probes do not publish a result.

The probe sends no application data and contacts no upstream. It checks TCP reachability only, including for HTTPS proxies; it does not validate credentials or forwarding capability.

Probe when `/ocpp` opens and after Address is saved, even with Routing off. Routing changes do not trigger a probe.

## Request Routing

Use a thin loopback relay to bridge OpenCode's endpoint configuration to Bun's HTTP proxy transport:

```text
opencode provider → private loopback relay → configured proxy → upstream
```

### Catalog Transforms

- While Routing is on, set the `opencode` provider's transport to HTTP.
- Transform only models whose provider ID is `opencode`. Resolve each original endpoint from model `settings.baseURL` or the unchanged provider defaults, then set its `settings.baseURL` to a private relay URL.
- Route explicit variant `settings.baseURL` overrides through the same relay. Preserve packages, model IDs, authentication, and unrelated settings.
- Every routed model receives a relay URL; missing or invalid upstream destinations fail clearly in the relay.
- While Routing is off, make no endpoint or transport changes.
- Keep transforms synchronous and replayable over fresh catalog inputs. This routes model requests through their existing implementations, including auxiliary and stateless calls.

### Streaming Relay

- Start one `Bun.serve` listener per server plugin instance on `127.0.0.1:0`, protected by an unpredictable path token.
- Encode the original upstream base URL in the relay prefix and preserve the appended request path and query.
- Reject invalid tokens with `404` and missing or unsupported upstream destinations with a clear error.
- Capture current settings when forwarding starts. Fail when Routing is off or Address is unset; never connect directly as a fallback.
- Forward with Bun fetch using `proxy: { url: proxyUrl.href, respectNoProxy: false }` and `decompress: false`.
- Stream request and response bodies without parsing or buffering. Preserve status, encoded bytes, and end-to-end headers.
- Remove hop-by-hop headers, including names listed by `Connection`, and derive Host from the upstream URL. Keep proxy credentials separate from upstream authentication.
- Let the transport handle redirects, keeping forwarding on the configured proxy. Do not add a retry, caching, or connection-management framework.
- Propagate cancellation and disable the relay's idle timeout so OpenCode governs model-request timeouts.
- Return cleanup that stops the listener and cancels outstanding forwarding. OpenCode manages transform registration lifetimes.

## `/ocpp` Dialog

Register `/ocpp` through the public TUI keymap API. Render a small Solid/OpenTUI settings component through `context.ui.dialog.show`, using semantic host theme tokens.

```text
  OpenCode Proxy Plugin                                  esc

  > Enable Proxy                                         off
    Proxy Address                         192.168.1.50:1080

  change ←/→                                    ⠋ Checking
```

- Match `/settings` layout, selection styling, right-aligned values, and keyboard/mouse navigation. The dialog contains two rows without search or filtering.
- `Enable Proxy` shows `on`/`off`; Enter or left/right toggles it while keeping the dialog and selection open. Display the server-confirmed value and prevent duplicate saves while an update is pending.
- Enter on `Proxy Address` opens the native `context.ui.dialog.prompt`, prepopulated with the saved address and showing the accepted address forms.
- On invalid input or a failed save, show an error and offer another prompt with the entered value preserved. Do not rebuild text-editing behavior.
- On successful Proxy Address save, return to the settings dialog with Proxy Address selected and probe the saved address. Empty input clears Proxy Address without changing Enable Proxy.
- Cancelling Proxy Address returns without saving or re-probing. Escape closes the settings dialog.
- The footer shows `change ←/→` on the left and proxy status on the right (`Reachable` or `Unreachable`), with a spinner and `Checking` while probing. Cancel superseded probes and ignore stale completions after a dialog closes or Proxy Address changes.
