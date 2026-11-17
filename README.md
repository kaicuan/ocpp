# ocpp

An OpenCode V2 plugin that routes the built-in `opencode` provider's model requests through an HTTP or HTTPS proxy.

## Requirements

- OpenCode 2.3.0.
- Bun 1.4.4 or newer for local development.

## Local setup

Install dependencies in this directory:

```sh
bun install
```

Add this directory to the existing `plugins` list in your OpenCode configuration. Use the global `~/.config/opencode/opencode.json` for all projects, or your project's `opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/ocpp"]
}
```

This loads both the server plugin and its terminal dialog. OpenCode reloads configuration changes automatically; `/reload` also forces a reload.

## Usage

Run `/ocpp` to open **OpenCode Proxy Plugin**.

- **Enable Proxy** defaults to `off`. Enter or left/right toggles it without closing the dialog.
- **Proxy Address** defaults to unset. Select it and press Enter to enter a proxy address. Saving or clearing it does not change Enable Proxy.
- Up/down navigates between rows. Escape closes the dialog; cancelling the address prompt leaves settings unchanged.

Accepted addresses include:

```text
192.168.1.50:8080
user:pass@192.168.1.50:8080
http://proxy.example:8080
https://proxy.example:8443
http://[::1]:8080
```

A missing scheme means `http://`. An omitted port uses 80 for HTTP or 443 for HTTPS. Percent-encode reserved characters in credentials. Paths other than `/`, queries, fragments, and SOCKS proxy addresses are not accepted.

With Enable Proxy on, only the exact `opencode` provider is routed. A missing address or failed proxy produces an error, never a direct fallback. Enable Proxy off removes the plugin's routing changes; independent process-wide proxy settings are not changed.

Settings persist in OpenCode's plugin storage. Proxy credentials are masked in the settings row, but the saved address contains them; protect your OpenCode data directory accordingly.

## Proxy status

The footer shows `Reachable` or `Unreachable`, with a spinner and `Checking` while it checks. It checks when the dialog opens and after Proxy Address is saved, even with Enable Proxy off.

This is a three-second TCP connectivity check from the **OpenCode server**, not the terminal client. It does not validate credentials, TLS, or the proxy's ability to forward requests.

## Development

```sh
bun run typecheck
```
