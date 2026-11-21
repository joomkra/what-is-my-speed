# What Is My Speed

A self-hosted internet speed monitor that runs the official **Ookla Speedtest CLI** on a schedule.
The dashboard is inspired on [speedtest-monitor](https://github.com/Greite/speedtest-monitor), with more configuration:

- **Profiles**: several independent test plans, all shown on one dashboard.
  - Schedule: an interval in minutes, a **cron** expression (with a live preview of the next runs), or manual only.
  - Server strategy:
    - **Auto**: nearest server.
    - **Fixed**: always the same server.
    - **Rotate**: round-robin through a list.
    - **All in list**: every server in the list is tested on each run.
  - Optional binding to a network interface (`--interface`) or a source IP (`--ip`).
- **Server directory**: search speedtest.net's server list (`/api/js/servers`) by city, provider or ID. You can also list the CLI's nearest servers or add servers by ID or hostname, save them to a library with custom labels, and run a one-off test against any server.
- **Shared queue**: tests run one at a time, so profiles never compete for bandwidth. The queue shows live progress (phase plus live ping, download and upload), and you can cancel or remove jobs.
- **Dashboard**:
  - Download, upload and latency cards with Good, Fair or Poor badges, sparklines and a "vs avg" trend.
  - Averages for jitter, packet loss and success rate.
  - A per-profile overview table.
  - A history chart with three views: **Overview**, **By profile** and **By server**. Each can show download, upload, idle or loaded latency, jitter, or loss.
  - A sortable and filterable measurements table with links to each speedtest.net result.
  - Profile filter chips and ranges of 1h, 6h, 24h, 7d, 30d and 90d.
- Live updates over Server-Sent Events, CSV export, retention pruning, configurable thresholds, a "pause all schedules" switch, light and dark themes, and optional basic auth.

## Run with Docker

```bash
docker compose up -d --build
# open http://localhost:3000
```

Data, including the SQLite DB and Ookla's license acceptance, is stored in `./data`.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `TZ` | UTC | Timezone used for cron schedules |
| `PUID` / `PGID` | `1000` | Owner of the files in `/data` |
| `AUTH_USER` / `AUTH_PASSWORD` | – | Enables HTTP basic auth when a password is set (user defaults to `admin`) |
| `DEFAULT_INTERVAL_MINUTES` | `30` | Interval of the profile created on first boot |
| `DATA_DIR` | `/data` | Database location |

**Interface binding:** in Docker, the profile's interface and source-IP options only see the container's own interfaces. To use host interfaces such as `wg0`, set `network_mode: host` and remove the `ports:` block.

**Architectures:** the image fetches the correct Ookla CLI build for amd64, arm64, armv7 and i386. For example:
`docker buildx build --platform linux/arm64 -t what-is-my-speed .`

**License:** the container runs the CLI with `--accept-license --accept-gdpr`. By running it, you accept Ookla's [EULA](https://www.speedtest.net/about/eula) and [privacy policy](https://www.speedtest.net/about/privacy).

### Prebuilt image (GitHub Container Registry)

Once the repository is on GitHub, `.github/workflows/docker.yml` builds a multi-arch image (amd64, arm64, armv7) and pushes it to `ghcr.io/<owner>/<repo>` on every push to `main` and on every `v*` tag. To use it, replace `build: .` in `docker-compose.yml` with:

```yaml
    image: ghcr.io/<owner>/<repo>:latest
```

The package is private at first. You can make it public in the package settings on GitHub.

## Run without Docker

You need Node ≥ 22.13 (for the built-in `node:sqlite`) and `speedtest` on your PATH.

```bash
npm install
npm run dev   # data goes to ./data, served on :3000
```

## API (short)

| Method | Path | |
|---|---|---|
| GET | `/api/profiles` | Profiles with their next run and latest result |
| POST/PUT/DELETE | `/api/profiles[/:id]` | Create, update or delete a profile |
| POST | `/api/profiles/:id/run` | Queue a profile run |
| POST | `/api/run` | Queue all enabled profiles. With `{server, profileId?}`, run a one-off test against that server |
| DELETE | `/api/jobs/:id` | Cancel a running job or remove a queued one |
| GET | `/api/servers/search?q=` | Search speedtest.net's server directory |
| GET | `/api/servers/nearby` | `speedtest -L` (cached for 10 minutes) |
| GET/POST/DELETE | `/api/servers/saved[/:id]` | Saved server library |
| GET | `/api/measurements?from&to&profile&server&status&search&sort&order&limit&offset` | Paginated measurements |
| GET | `/api/series`, `/api/summary` | Chart data and aggregates |
| GET | `/api/export.csv` | CSV export (accepts the same filters) |
| GET/PUT | `/api/settings` | Thresholds, retention, timeout, pause |
| GET | `/api/events` | SSE stream: `state`, `progress`, `measurement`, `profiles` |
| GET | `/api/health` | Health check (no auth) |

## License

MIT. See [LICENSE](LICENSE).
