# Setup guide

| I want to… | Use | Needs |
|---|---|---|
| Try it on my machine | [Run it locally with Docker](#run-it-locally-with-docker) | Docker |
| Host it for myself or others | [Self-host on a server](#self-host-on-a-server) | A machine that runs Docker |
| Change the code | [Develop from source](#develop-from-source) | Python 3.11, Node.js for the tests |

## Run it locally with Docker

```bash
docker run --rm -p 127.0.0.1:8000:8000 ghcr.io/shannenlolol/image-editor-web-app:latest
```

- Open [http://localhost:8000](http://localhost:8000)
- Stop with Ctrl+C
- First run downloads the image (~800 MB)

## Self-host on a server

### What you need

- **Docker with Docker Compose** on a NAS, home server or cloud server
  - Intel/AMD (`x86_64`) or ARM (`aarch64`)
  - Built and tested on a UGREEN NAS
- **~1.2 GB free memory**: ~300 MB idle, up to ~1 GB during two removals at once
- **A way to publish it** (optional): a reverse proxy, or a [Cloudflare Tunnel](#4-publish-it-with-a-cloudflare-tunnel) (no open ports)

### 1. Connect to your server

- Commands run **on the server**, over SSH from your computer's terminal (Terminal on macOS, PowerShell on Windows)
- You connect to the server itself, not to Docker or a container
- Skip this step if you're working on the server directly

**a. Turn on SSH**
- UGREEN NAS: UGOS web interface → **Control Panel → Terminal** → tick **Enable SSH** → port **22** → Apply
- Other NAS systems: look under Terminal, Services or SSH
- Linux servers: usually on already

**b. Find the server's IP address** (looks like `192.168.x.x` or `10.0.x.x`)
- NAS web interface → **Control Panel → Network**
- NAS phone app → device info
- Router admin page → connected devices
- Must be on the same network as the server; from elsewhere, use a VPN such as [Tailscale](https://tailscale.com/) and its address instead

**c. Connect** with an **administrator** account (UGREEN only allows admins)

```bash
ssh your-username@192.168.1.50
```

- First time: asks whether you trust the server → type `yes`
- Password doesn't appear as you type (normal)
- Connected when the prompt shows the server's name, e.g. `your-username@DH4300PLUS:~$`
- `exit` to disconnect

| Message | Fix |
|---|---|
| `Connection refused` | SSH is off, or not on port 22 (`ssh -p <port> …`) |
| `Connection timed out` / `No route to host` | Wrong IP, or not on the same network |
| `Permission denied` | Wrong password, or not an administrator |

**d. Check Docker works**

```bash
docker ps        # "permission denied"? use: sudo docker ps
```

- Needed `sudo`? Put it in front of every `docker` command below too

### 2. Start the app

- Only [`docker-compose.yml`](../docker-compose.yml) is needed; the image is downloaded ready-built (no git required)
- Put it next to your other apps; on UGREEN usually `/volume1/docker`

```bash
cd /volume1/docker            # or wherever you keep your apps
mkdir image-editor && cd image-editor
curl -O https://raw.githubusercontent.com/shannenlolol/image-editor-web-app/main/docker-compose.yml
docker compose pull
docker compose up -d
```

- `mkdir` permission denied? → `sudo mkdir image-editor`, then `sudo curl …`
- Wait ~30 s until `docker compose ps` shows **healthy**, then check:

```bash
curl http://127.0.0.1:8081/healthz   # prints "ok"
```

**Using a NAS Docker app instead?** (e.g. UGREEN)
- **Project → Create**
- Paste the contents of `docker-compose.yml`
- **Remove the `build: .` line** (the NAS downloads the image, it doesn't build it)

### 3. Check the settings

All in `docker-compose.yml`:

| Setting | Default | Change it when |
|---|---|---|
| `ports: "127.0.0.1:8081:8000"` | Only reachable from the server, port 8081 | 8081 is taken → change the **left** number, e.g. `127.0.0.1:8082:8000` |
| `TRUST_CF_CONNECTING_IP: "1"` | Rate limits use the visitor IP from Cloudflare | **Not** behind Cloudflare → remove it (otherwise visitors can fake their IP) |
| `image: …:latest` | Installs every release | Only want bug fixes → use `…:1.1` |
| `mem_limit: 1200m` | Memory cap | Server has more, or less, to spare |

Fixed in [`app.py`](../app.py):
- Uploads up to 20 MiB and 25 megapixels
- 10 background removals per minute per visitor
- At most 2 removals at once

### 4. Publish it with a Cloudflare Tunnel

- Lets people reach the app through your domain, with no ports opened on your router
- Needs a domain whose DNS is on Cloudflare
- One tunnel can serve every app on the server

**a. Create the tunnel**
- Cloudflare dashboard → **Networking → Tunnels → Create Tunnel**
- Name it (e.g. `nas`) → choose **Docker**
- Copy the **token** from the command shown
- Keep the token private: anyone with it can attach to your tunnel

**b. Run `cloudflared`** on the server, in its own folder, with this `docker-compose.yml`:

```yaml
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: "paste-your-token-here"
    # Shares the server's network, so the tunnel can reach apps on localhost.
    network_mode: host
    labels:
      com.centurylinklabs.watchtower.enable: "true"
```

**c. Add a route** on the tunnel (also called public hostname)
- Subdomain + domain of your choice
- Service URL: `http://localhost:8081`
- Use `http`, not `https` (Cloudflare provides HTTPS to visitors)

**d. Add a rate limiting rule** (recommended)
- Your domain → **Security** → rate limiting rule
- Expression:
  ```
  (http.host eq "your.hostname" and starts_with(http.request.uri.path, "/remove-bg"))
  ```
- Characteristics: IP
- e.g. 10 requests per 10 seconds → Block for 10 seconds

### 5. Keep it up to date with Watchtower

- The app's container is already labelled for [Watchtower](https://watchtower.nickfedor.com/)
- One Watchtower updates every labelled container, so you only need one per server
- Not running Watchtower yet? Add this to the app's `docker-compose.yml`, then `docker compose up -d`:

```yaml
  watchtower:
    image: nickfedor/watchtower   # maintained fork of the archived containrrr/watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      WATCHTOWER_LABEL_ENABLE: "true"   # only update labelled containers
      WATCHTOWER_CLEANUP: "true"        # delete replaced images
      WATCHTOWER_POLL_INTERVAL: "300"   # check every 5 minutes
```

- Update by hand instead: `docker compose pull && docker compose up -d`

### Monitoring

- `/healthz` returns `ok` without loading the page
- Use it for uptime monitors (e.g. UptimeRobot keyword monitor for `ok`)

## Develop from source

```bash
git clone https://github.com/shannenlolol/image-editor-web-app.git
cd image-editor-web-app
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
flask --app app run --debug --port 5001
```

- Open [http://localhost:5001](http://localhost:5001)
- Python 3.11 recommended
- Port 5001 avoids macOS AirPlay Receiver on 5000

### Run the tests

```bash
python -m unittest discover tests
node --test tests/*.cjs
```

- Python tests replace the model with a stand-in, so they run in under a second

### Build the Docker image yourself

```bash
docker compose up -d --build
```

- Builds from the `Dockerfile` instead of downloading the published image

### Deploy your own fork

- The workflow publishes to `ghcr.io/<your-username>/<your-repo>`
- Fork → push a version tag (see [Releasing](#releasing))
- Server's `docker-compose.yml` → change `image:` to your fork's image
- Can't download it? GitHub profile → **Packages** → the package → **Package settings** → make it public
- Each tag you push is then built and, with Watchtower, deployed

## Releasing

```bash
git tag v1.1.0
git push origin v1.1.0
```

- GitHub Actions builds for Intel and ARM and publishes `1.1.0`, `1.1` and `latest`
- Merging to `main` alone publishes nothing
- Pre-releases (e.g. `v1.2.0-rc1`) are published but never become `latest`

## Troubleshooting

| Problem | Fix |
|---|---|
| Port already allocated | Another app uses 8081 → change the left port in `docker-compose.yml` |
| `curl …/healthz` shows another app's page | Same: something else is on that port |
| `docker compose pull` says **denied** | Image is private (forks) → make the package public, or `docker login ghcr.io` |
| **502 Bad Gateway** through the tunnel | Route must be `http://localhost:<port>` (not `https`); check `curl http://127.0.0.1:<port>/healthz` prints `ok` |
| Tunnel never connects | Token pasted whole? Check the `cloudflared` container's log |
| Removal says **Busy** | Two removals already running → retry in a few seconds |
| Removal says **Too many requests** | Over 10 removals in a minute → wait a minute |
