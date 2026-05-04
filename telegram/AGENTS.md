# Telegram Module Guide

## Scope
Telegram control plane, poll ownership, sentinel process, and WhatsApp notifier.

## Start Files
- `telegram/telegram-bot.mjs` - Telegram command/update handling.
- `telegram/telegram-surface-runtime.mjs` - bounded UI-runtime bridge for Telegram.
- `telegram/telegram-poll-owner.mjs` - polling ownership guard.
- `telegram/telegram-sentinel.mjs` - background sentinel runtime.
- `telegram/whatsapp-channel.mjs` - optional WhatsApp notifications.
- `telegram/get-telegram-chat-id.mjs` - utility CLI.

## Common Task Routing
- Command/menu behavior -> `telegram-bot.mjs`, `telegram-surface-runtime.mjs`, `server/routes/harness-*.mjs`; `infra/monitor.mjs` owns Telegram surface lifecycle.
- Polling conflicts -> `telegram-poll-owner.mjs`, sentinel runtime.
- Delivery/reporting issues -> `telegram-bot.mjs`, `whatsapp-channel.mjs`.

## Tests
- Focused: `npm test -- tests/telegram*.test.mjs tests/whatsapp-channel.test.mjs`
- Full: `npm test`
