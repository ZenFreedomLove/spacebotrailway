#!/bin/sh
set -e
mkdir -p "$SPACEBOT_DIR"

cat > "$SPACEBOT_DIR/config.toml" <<EOF
[api]
bind = "::"

[llm]
openrouter_key = "${OPENROUTER_API_KEY}"

[defaults.routing]
channel = "openrouter/free"
worker = "openrouter/free"
branch = "openrouter/free"

[messaging.discord]
enabled = true
token = "${DISCORD_BOT_TOKEN}"

[messaging.telegram]
enabled = true
token = "${TELEGRAM_BOT_TOKEN}"

[[agents]]
id = "main"
default = true

[[bindings]]
agent_id = "main"
channel = "discord"
guild_id = "${DISCORD_GUILD_ID}"

[[bindings]]
agent_id = "main"
channel = "telegram"
EOF

echo "Generated config.toml from environment variables"
exec "$@"
