# Social Ripper

A small local web app for downloading public social media reels, posts, and videos with format and quality controls.

## Run locally

Install Node.js 20 or newer. On Linux and other Unix-like systems, the bundled yt-dlp launcher also needs [a supported Python version](https://github.com/yt-dlp/yt-dlp#dependencies).

```bash
npm install
npm start
```

Open `http://127.0.0.1:3000`. The server binds to localhost by default and does not upload links or media to another service.

For image posts and carousel ZIPs, install [gallery-dl](https://github.com/mikf/gallery-dl#installation) and make it available on your `PATH`. The server also checks `node_modules/.bin`. If you manage the tools yourself, you can set `YT_DLP_BIN`, `FFMPEG_BIN`, or `GALLERY_DL_BIN` to the executable's path before starting the server.

If you moved the project across operating systems, run `npm rebuild ffmpeg-static youtube-dl-exec` to install native media tools. Visit `/api/health` to check which executables the server can find.

## Supported media

The app accepts public HTTPS links from Instagram, TikTok, YouTube, Facebook, X/Twitter, Threads, Vimeo, Reddit, and Pinterest. Platform changes, private posts, regional restrictions, or login requirements can prevent extraction.

Video formats include MP4, WEBM, and MP3. On sources supported by gallery-dl, image mode saves the first original image and carousel mode returns up to 20 original images from the post as a ZIP. FFmpeg converts those images to JPG/JPEG, PNG, or WEBP. The server checks the 250 MB limit during processing and before sending the result. Preview and download jobs share two processing slots.

Only download media you own or have permission to save. Follow the source platform's terms and applicable copyright law.

## Test

```bash
npm test
```
