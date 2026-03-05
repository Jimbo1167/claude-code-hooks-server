# Claude Code Hooks Server

HTTP hooks server that receives and logs Claude Code session events to a SQLite database with a web dashboard.

## Setup

```bash
cd hooks-server
npm install
npm run build
npm start
```

For development with auto-reload:

```bash
npm run dev
```

The server runs on `http://localhost:3003` by default.

## Configuration

Create a `.env` file (or edit the existing one):

```
PORT=3003
DB_PATH=./hooks.db
```

## Configure Claude Code Hooks

Add this to your `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:3003/hooks/session-start"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:3003/hooks/pre-tool-use"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:3003/hooks/post-tool-use"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:3003/hooks/stop"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "http",
            "url": "http://localhost:3003/hooks/session-end"
          }
        ]
      }
    ]
  }
}
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/hooks/session-start` | Log session start events |
| POST | `/hooks/pre-tool-use` | Log pre-tool-use events |
| POST | `/hooks/post-tool-use` | Log post-tool-use events |
| POST | `/hooks/stop` | Log stop events |
| POST | `/hooks/session-end` | Log session end events |
| GET | `/api/sessions` | Get recent sessions (last 10) |
| GET | `/api/events?session_id=<id>` | Get events for a session |
| GET | `/` | Dashboard |

## Dashboard

Open `http://localhost:3003` in your browser to see the dashboard with session history and tool call details.
