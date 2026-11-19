<p align="left">
  <img src="icons/icon-192.png" width="56" height="56" alt="Social Ripper logo">
</p>

# Social Ripper

A self-hosted web app and installable PWA for saving video, audio, and images from public social media links. Preview the source, pick an output format, and stream downloads straight to your device—or share links directly from mobile apps into **SocialRipper**.

![Social Ripper workspace with URL, media type, format, and quality controls](docs/images/workspace.webp)

## Formats and sources

| Media | Output | Options |
| --- | --- | --- |
| Video or reel | MP4, WebM | Best available, or up to 1080p, 720p, or 480p (remuxes or recodes via FFmpeg when needed) |
| Audio from a video | MP3 | 320, 192, or 128 kbps |
| Image post | JPG, PNG, WebP | First available image from the post (`mjpeg -q:v 2`, lossless `png`, `libwebp -quality 90`) |
| Carousel | ZIP | Up to 20 images in the selected image format (`store`-mode ZIP) |

The app accepts public HTTPS links from:
- **Instagram** (`instagram.com`)
- **TikTok** (`tiktok.com`)
- **YouTube** (`youtube.com`, `youtu.be`)
- **Facebook** (`facebook.com`, `fb.watch`)
- **X / Twitter** (`x.com`, `twitter.com`)
- **Threads** (`threads.net`, `threads.com`)
- **Vimeo** (`vimeo.com`)
- **Reddit** (`reddit.com`, `redd.it`)
- **Pinterest** (`pinterest.com`, `pin.it`)

Available formats depend on the source and its restrictions. Downloads have **no artificial file-size cap** (bounded only by available disk space and upstream platform limits), stream straight to disk without buffering in browser memory, and preserve Unicode titles via RFC 5987 `Content-Disposition` filenames.

**Download only media you own or have permission to save.** Platform restrictions still apply.

## Preview and download

1. Paste a public HTTPS link and choose **Reel / video**, **Image post**, or **Carousel (ZIP)**.
2. Select a format and quality, then click **Inspect link**. (On phones and tablets, the Extraction Desk sits at the top of the page so you can paste and inspect without scrolling.)
3. Confirm the source in the preview and click **Download**. Use **Cancel** at any time to abort an active inspection or download preparation.

The masthead displays live tool readiness (`ENGINE ONLINE`, `VIDEO / AUDIO ONLY` when `gallery-dl` is unavailable and image/carousel options are disabled, or `ENGINE UNAVAILABLE`).

<p align="center">
  <img src="docs/images/preview.webp" width="640" alt="The full Social Ripper download panel showing a YouTube URL, selected 720p quality, and an MP4 download button below the source preview">
</p>

*Preview sample © 2008 Blender Foundation. [Big Buck Bunny license](https://peach.blender.org/about/).*

## Install as an app (PWA & direct sharing)

Social Ripper is an installable Progressive Web App (PWA) with Android **Web Share Target** support:

- **Android & Desktop (Chrome, Edge, Brave):** Install from the bottom **Install Social Ripper** popup (dismisses for 7 days) or the **INSTALL APP** button in the header. Once installed on Android, tap **Share** in Instagram, TikTok, YouTube, X, Reddit, or Pinterest and pick **SocialRipper**—the app extracts the HTTPS URL from shared text/captions, auto-inspects it (falling back from video to image/carousel when `gallery-dl` is available), and puts the **Download** button immediately on screen.
- **iPhone / iPad (Safari):** Open the install popup or tap **INSTALL APP** and follow Safari's **Share → Add to Home Screen** steps. You can also launch Social Ripper with `/?url=<encoded-link>` from an Apple Shortcut.
- **HTTPS requirement:** Mobile browsers only enable PWA installation and Android Share Sheet registration when served over HTTPS (local desktop browsers also allow `http://127.0.0.1` and `http://localhost`). Deploy behind HTTPS (for example Nginx, Caddy, Cloudflare Tunnel, or Tailscale HTTPS) to install on your phone.

## Run locally

Use Node.js 20 or newer. On Unix, the bundled yt-dlp launcher also needs [a supported Python version](https://github.com/yt-dlp/yt-dlp#dependencies). For photos and carousels, install [gallery-dl](https://github.com/mikf/gallery-dl#installation) and make it available on your `PATH`.

```bash
git clone https://github.com/Dipak-Chauhan/social-ripper.git
cd social-ripper
npm ci
npm start
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). Visit `/api/health` to check whether the server can find each executable. Run `npm test` for the backend test suite.

| Environment variable | Purpose |
| --- | --- |
| `HOST` / `PORT` | Listen address and port. Defaults to `127.0.0.1:3000`. Binding `0.0.0.0` or `::` permits direct LAN IP access while still blocking arbitrary DNS-rebinding hostnames. |
| `ALLOWED_HOSTS` | Comma-separated public hostnames allowed by the same-origin check (e.g. `media.example.com`). |
| `DOWNLOAD_TIMEOUT_MS` | Maximum time in milliseconds for a download/conversion job (shared deadline across carousel images). Defaults to `3600000` (60 minutes). |
| `PENDING_DOWNLOAD_TTL_MS` | Time in milliseconds before an unclaimed one-time `/api/downloads/:token` link expires and cleans up its temporary directory. Defaults to `60000` (60 seconds). |
| `YT_DLP_BIN` / `FFMPEG_BIN` | Paths to separately installed binaries when overriding the bundled tools. |
| `GALLERY_DL_BIN` | Path to gallery-dl when it is installed outside `PATH` and `node_modules/.bin`. |

## How it works

The Node.js server serves the web interface, PWA assets (`/manifest.webmanifest`, `/sw.js`, `/icons/*.png`), and `/share-target` route on the same origin. `sw.js` caches the static app shell while bypassing all `/api/*` requests so media inspections and file streams are never intercepted.

- `GET /api/health` reports `yt-dlp`, `ffmpeg`, and `gallery-dl` availability.
- `POST /api/info` retrieves sanitized metadata and preview dimensions.
- `POST /api/downloads` prepares video/audio via `yt-dlp` and `ffmpeg` or images via `gallery-dl` and `ffmpeg`, returning a one-time `GET /api/downloads/:token` URL so the browser streams the file (or store-mode Archiver ZIP for carousels) straight to disk without RAM buffering.
- `POST /api/download` is also supported for direct single-request streaming.

Media processing uses the server's temporary storage. Inspection and download jobs share two concurrent slots per process. The server terminates entire child process groups when a client disconnects or on `SIGINT`/`SIGTERM` shutdown and removes temporary directories after every job.

## Public deployment

1. Run `npm ci` and `npm start` as a persistent Node.js service with outbound HTTPS access and writable temporary storage.
2. Keep the Node.js port private and put the public hostname behind an HTTPS reverse proxy. Either set `ALLOWED_HOSTS=media.example.com` on Node.js (and forward the public `Host` and `Origin` headers) or rewrite them at the proxy to match the upstream HTTP address.
3. Rate-limit `/api/info`, `/api/download`, and `/api/downloads` at the proxy. Check `/api/health`, then inspect and download a sample through the public HTTPS URL.

<details>
<summary>Nginx configuration example</summary>

Add the rate-limit zone inside Nginx's `http` block.

```nginx
limit_req_zone $binary_remote_addr zone=social_ripper:10m rate=12r/m;
```

Add the following to your HTTPS `server` block. Replace `media.example.com` with your public hostname and adjust the upstream address and port to match Node.js. If Node.js is started with `ALLOWED_HOSTS=media.example.com`, you can forward the public `Host` and `Origin` directly instead of overriding them.

```nginx
server_name media.example.com;

if ($host != media.example.com) {
    return 421;
}

location / {
    proxy_pass http://127.0.0.1:3000;
}

location ~ ^/api/(info|download|downloads)$ {
    if ($http_origin != "https://media.example.com") {
        return 403;
    }

    limit_req zone=social_ripper burst=4 nodelay;
    limit_req_status 429;

    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host 127.0.0.1:3000;
    proxy_set_header Origin http://127.0.0.1:3000;
    proxy_read_timeout 60m;
    proxy_buffering off;
}

location ^~ /api/downloads/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host 127.0.0.1:3000;
    proxy_set_header Origin http://127.0.0.1:3000;
    proxy_buffering off;
    proxy_max_temp_file_size 0;
    proxy_read_timeout 60m;
}
```

Test the configuration with `nginx -t` before reloading. [Nginx proxy directives](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) · [Request limiting](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html)

</details>

### Troubleshooting

| Symptom | What to check |
| --- | --- |
| Engine unavailable or HTTP 503 | Check `/api/health` and confirm `yt-dlp` and `ffmpeg` are executable on the host. |
| Image options disabled or fail | Confirm `gallery-dl` is available on `PATH`, `node_modules/.bin`, or `GALLERY_DL_BIN`, and that the post exposes downloadable images. |
| Install prompt or Android Share Sheet missing | Mobile browsers require HTTPS for PWA installation and Web Share Target. Check that `/manifest.webmanifest` and `/sw.js` return `200`. |
| HTTP 403 on LAN or after deploying | For LAN IP access bind `HOST=0.0.0.0`; behind a reverse proxy set `ALLOWED_HOSTS=<hostname>` or verify the proxy's `Host` and `Origin` headers. |
| HTTP 404 when saving a file | One-time `/api/downloads/:token` links expire once fetched or after `PENDING_DOWNLOAD_TTL_MS`. Click **Download** again to prepare a fresh stream. |
| HTTP 429 | Both job slots may be busy, or the proxy's rate limit may have been reached. Retry after a short wait. |
