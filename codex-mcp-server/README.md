# Codex MCP Server

Small MCP server that exposes a `run_codex_task` tool to drive `codex exec --full-auto --json` against a local workspace for ChatGPT Apps.

## Environment

- `CODEX_WORKSPACE` (required): absolute path to the repo Codex should edit. Example in `.env.example`.
- `PORT` (optional): HTTP port for the MCP transport, defaults to `3000`.

## Run locally

```bash
cd codex-mcp-server
export CODEX_WORKSPACE=/absolute/path/to/repo
export PORT=3000
npm install
npm run dev
# Logs: Codex MCP Server running on http://localhost:3000/mcp
```

## Expose via ngrok

```bash
ngrok http 3000
# MCP URL: https://<id>.ngrok.app/mcp
```

Connect this MCP endpoint as a tool in your ChatGPT App. ChatGPT will call `run_codex_task` with a task ID and prompt, and the server will orchestrate the Codex CLI inside `CODEX_WORKSPACE`.
