# Strava sync

An Obsidian plugin that creates one note per Strava activity.

Minimal by design — it does two things: connect your Strava account (OAuth) and
sync activities into notes with `date` and `title` properties.

> A detailed, beginner-friendly walkthrough in Polish lives in
> [INSTRUKCJA.md](INSTRUKCJA.md).

## Features

- **OAuth login** to Strava, from settings or the command palette.
- **Sync** activities, from settings or the command palette.
- **One note per activity**, named after the Strava activity ID, with `date`
  and `title` properties plus a short stats block.
- **Built around Strava's rate limits**: 200 activities per request,
  incremental sync, no per-activity detail calls, and a safety margin read from
  the `X-RateLimit-*` response headers.

## Setup

1. Build the plugin:

    ```bash
    npm install && npm run build
    ```

2. Create an API application at <https://www.strava.com/settings/api> and set
   **Authorization Callback Domain** to `localhost`.
3. In **Settings → Strava sync**, paste your **Client ID** and
   **Client secret**, then select **Connect to Strava**.
4. Select **Sync now**.

## Commands

- `Strava sync: Connect to Strava`
- `Strava sync: Sync activities`

## Note format

```markdown
---
date: 2025-08-12
title: Morning Run
---

# Morning Run

2025-08-12T06:31:00

## Stats
- Sport: Run
- Distance: 10.05 km
- Moving time: 48:12
- Average pace: 4:48 /km
- Average heart rate: 152 bpm

[View on Strava](https://www.strava.com/activities/14567890123)
```

## Notes

- **Desktop only.** Login uses a short-lived local HTTP server on `localhost`,
  because Strava requires a real callback domain and does not accept custom
  protocols such as `obsidian://`.
- Your tokens and client secret are stored in `data.json` inside the plugin
  folder and are never sent anywhere except to Strava. That file is gitignored —
  do not share it.
- Scope requested is `activity:read_all` (read only, including private
  activities). The plugin never writes to Strava.

## Privacy

The plugin talks to `www.strava.com` only, and only when you connect or sync.
No telemetry, no third-party services.

## License

0-BSD — see [LICENSE](LICENSE).
