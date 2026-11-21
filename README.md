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

## Install

Requires Docker with the Compose plugin. Prebuilt images for **amd64**, **arm64** and **armv7** are published to
[`ghcr.io/joomkra/what-is-my-speed`](https://github.com/joomkra/what-is-my-speed/pkgs/container/what-is-my-speed).

### Docker Compose (recommended)

```bash
mkdir what-is-my-speed && cd what-is-my-speed
curl -fsSLO https://raw.githubusercontent.com/joomkra/what-is-my-speed/main/docker-compose.yml
docker compose up -d
```

Open **http://localhost:3000** (or `http://<server-ip>:3000`). On first visit, confirm the Ookla license notice. A default
"Auto (nearest)" profile then runs every 30 minutes. Add more profiles and servers in the **Profiles** and **Servers** tabs.

### Docker run

```bash
docker run -d --name what-is-my-speed --restart unless-stopped \
  -p 3000:3000 \
  -v ./data:/data \
  -e TZ=Europe/Warsaw \
  ghcr.io/joomkra/what-is-my-speed:latest
```

### Unraid

A template is included in [`templates/what-is-my-speed.xml`](templates/what-is-my-speed.xml). To install it, open the Unraid terminal (**>_** in the top bar) and run:

```bash
wget -O /boot/config/plugins/dockerMan/templates-user/my-what-is-my-speed.xml \
  https://raw.githubusercontent.com/joomkra/what-is-my-speed/main/templates/what-is-my-speed.xml
```

Then go to **Docker → Add Container**, pick **what-is-my-speed** from the **Template** dropdown, and click **Apply**.

- Data is stored in `/mnt/user/appdata/what-is-my-speed`, owned by `nobody:users` (PUID 99 / PGID 100).
- The WebUI is on port 3000. It's also available from the container's icon menu.
- Unraid sets the timezone automatically.
- To require a login, set **Basic auth password**.
- To update, use **Check for Updates** on the Docker tab, or follow the orange dot in the dashboard footer.

### Updating

The dot next to the version number at the bottom of the dashboard is green when you're on the newest version and
orange when there's a newer one. To update:

```bash
docker compose pull && docker compose up -d
```

To pin a specific version, use a tag such as `ghcr.io/joomkra/what-is-my-speed:0.0.2` instead of `latest`. See the
[tags](https://github.com/joomkra/what-is-my-speed/tags) for available versions.

### Build from source

```bash
git clone https://github.com/joomkra/what-is-my-speed.git
cd what-is-my-speed
docker compose up -d --build   # after switching docker-compose.yml from `image:` to `build: .`
```

## Configuration

Data, including the SQLite DB and Ookla's license acceptance, is stored in the `/data` volume (`./data` with the compose file above).

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `TZ` | UTC | Timezone used for cron schedules |
| `PUID` / `PGID` | `1000` | Owner of the files in `/data` |
| `AUTH_USER` / `AUTH_PASSWORD` | – | Enables HTTP basic auth when a password is set (user defaults to `admin`) |
| `DEFAULT_INTERVAL_MINUTES` | `30` | Interval of the profile created on first boot |
| `DATA_DIR` | `/data` | Database location |
| `UPDATE_CHECK` | `true` | Look up the newest `v*` tag on GitHub (cached for 6h). The footer dot turns green when you're up to date and orange when a newer version exists |
| `UPDATE_CHECK_REPO` | `joomkra/what-is-my-speed` | Repository used for the update check |

**Interface binding:** in Docker, the profile's interface and source-IP options only see the container's own interfaces. To use host interfaces such as `wg0`, set `network_mode: host` and remove the `ports:` block.

**Reverse proxy:** live updates use Server-Sent Events on `/api/events`. Disable response buffering for that path (nginx: `proxy_buffering off;`).

**License:** the container runs the CLI with `--accept-license --accept-gdpr`. A one-time notice in the UI and a line in the startup log both say this. By running it, you accept Ookla's [EULA](https://www.speedtest.net/about/eula) and [privacy policy](https://www.speedtest.net/about/privacy).

## Development

You need Node ≥ 22.13 (for the built-in `node:sqlite`) and the [Ookla Speedtest CLI](https://www.speedtest.net/apps/cli) (`speedtest`) on your PATH.

```bash
git clone https://github.com/joomkra/what-is-my-speed.git
cd what-is-my-speed
npm install
npm run dev   # data goes to ./data, served on :3000
```

Pushing to `main` or a `v*` tag builds and publishes the multi-arch image through `.github/workflows/docker.yml`.
To release, bump `version` in `package.json`, commit, then run `git tag -a vX.Y.Z -m vX.Y.Z && git push origin main --tags`.

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
