# Conflict Lens (ChatGPT App)

Conflict Lens finds **contradictory claims inside the model's learned literature** and shows them in an inline ChatGPT widget.

This is a warning tool: it emits conflict signals, not paper-level citations.

## What you deploy

- MCP endpoint: `/mcp`
- Widget UI: served through an Apps SDK resource (`text/html+skybridge`)

## Local run

```bash
npm install
OPENAI_API_KEY=your_key npm start
```

Open:
- http://localhost:3000/conflict-lens.html
- http://localhost:3000/mcp

## Analytics (optional, recommended)

Set:
- `POSTHOG_API_KEY`
- `POSTHOG_HOST` (default in Render blueprint is PostHog Cloud)

Events:
- `conflict_lens_run` (topic, conflict_count, elapsed_ms)
- `conflict_lens_found_via` (directory/chatgpt_suggested/link/friend/other)

## Deploy to Render (fastest)

Use Render Blueprint (render.yaml). Create a new Render project and deploy from this repo.

## Connect to ChatGPT

ChatGPT (Developer Mode enabled):
Settings → Apps & Connectors → Create / New App → MCP URL:

`https://YOUR-RENDER-SERVICE.onrender.com/mcp`

## Submit to the ChatGPT App Directory

See OpenAI docs:
- App submission guide
- App submission guidelines

