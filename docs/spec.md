# Specification: OpenCode Proxy Plugin (ocpp)

## Goal

Let the built-in `opencode` provider's model requests reach their upstream through an HTTP proxy.

## Features

### `/ocpp`

A dialog (`OpenCode Proxy Plugin`) for the proxy connection that matches OpenCode's `/settings` in appearance and interaction.

- **Enable Proxy** — `on` or `off`; defaults to `off`.
- **Proxy Address** — opens a second dialog that prompts for the address, following OpenCode's `/connect`: `host:port`, optionally with credentials as `user:pass@host:port` (e.g. `192.168.1.50:1080`). Defaults to `http://` when no scheme is provided.

### Proxy status

Proxy reachability is shown in the `/ocpp` footer (`Reachable` or `Unreachable`), with a `change ←/→` hint and a spinner with `Checking` while probing. It is probed when `/ocpp` opens and when `Proxy Address` is updated, using the configured address and credentials.

### Request routing

- With Enable Proxy `on`, `opencode` model requests reach the upstream through the proxy at the configured address.
- With Enable Proxy `off`, all providers connect directly.
- `opencode` is the only provider whose traffic is ever routed; every other provider connects directly regardless of Enable Proxy.
