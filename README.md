# Social Ripper

A small local web app for downloading public social media reels, posts, and videos with format and quality controls.

## Run locally

Requirements: Node.js 20 or newer.

```bash
npm install
npm start
```

Open `http://127.0.0.1:3000`. The server binds to localhost by default and does not upload links or media to another service.

## Supported media

The app accepts public HTTPS links from Instagram, TikTok, YouTube, Facebook, X/Twitter, Threads, Vimeo, Reddit, and Pinterest. Platform changes, private posts, regional restrictions, or login requirements can prevent extraction.

Video formats include MP4, WEBM, and MP3. Image posts can be converted to JPG/JPEG, PNG, or WEBP, while carousels are returned as a ZIP containing up to 20 converted images. Downloads are limited to 250 MB and processed with the pinned `youtube-dl-exec`, `ffmpeg-static`, and `archiver` packages.

Only download media you own or have permission to save. Follow the source platform's terms and applicable copyright law.

## Test

```bash
npm test
```
