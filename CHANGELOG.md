# Changelog

## Unreleased

**Changed**

- Releases are now built and published by GitHub Actions from the pushed tag,
  so a release can no longer contain a stale or mismatched installer. macOS
  builds are produced too, though still untested.
- `npm run release <patch|minor|major>` bumps the version everywhere and
  promotes the changelog in one step.

## 1.1.0

First public release.

**Added**

- Peer details panel. Click a person, then the `i` button, to see their device
  ID, address, and when they were first and last seen - plus a **Forget this
  person** button for clearing out stale contacts.
- Switchable urgent alert themes: Signal, Constructivist, Terminal, Panel and
  Phosphor. The style is chosen by the *sender* and travels with the message, so
  your alerts look like yours on every screen they land on.
- **Preview what they will see** in Settings, to judge a theme full screen.
- Tray icon now has a distinct state while an urgent alert is unacknowledged.
- macOS support written (simple fullscreen, template menu-bar icon, dock bounce,
  dock-click reveal). **Untested - no Mac was available.**

**Fixed**

- The alert only maximised instead of going fullscreen on Windows, leaving the
  taskbar on top of it.
- A UTF-8 BOM in the settings file silently reset your identity.
- Multicast joined only one network interface, so machines with Docker/WSL/VPN
  adapters discovered each other unreliably.
- Peers announced from every interface and the last one won, so an unroutable
  address could be recorded. Delivery now tries each known address.
- The Settings dialog could grow past the window, hiding the Save button.
- A malformed message payload could blank the whole chat window.

## 1.0.0

Internal build. Serverless peer-to-peer LAN chat with fullscreen urgent alerts.
