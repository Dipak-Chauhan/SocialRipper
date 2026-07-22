const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const youtubeDlPackage = require('youtube-dl-exec');
const ffmpegPath = require('ffmpeg-static');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY_BYTES = 16 * 1024;
const MAX_ACTIVE_DOWNLOADS = 2;
const MAX_FILE_SIZE = '250M';
const MAX_FILE_BYTES = 250 * 1024 * 1024;
const YT_DLP_PATH = youtubeDlPackage.constants.YOUTUBE_DL_PATH;

const SUPPORTED_DOMAINS = [
  'instagram.com',
  'tiktok.com',
  'youtube.com',
  'youtu.be',
  'facebook.com',
  'fb.watch',
  'x.com',
  'twitter.com',
  'threads.net',
  'vimeo.com',
  'reddit.com',
  'pinterest.com',
  'pin.it'
];

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/social-ripper.css', ['social-ripper.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]
]);

const VIDEO_QUALITIES = new Set(['best', '1080', '720', '480']);
const AUDIO_QUALITIES = new Set(['320', '192', '128']);
const CONTENT_TYPES = new Set(['video', 'post', 'carousel']);
const IMAGE_FORMATS = new Set(['jpg', 'jpeg', 'png', 'webp']);
let activeDownloads = 0;

class AppError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function validateMediaUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(400, 'Paste a public media link to continue.');
  }

  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new AppError(400, 'Enter a complete link from a supported site.');
  }

  if (parsed.protocol !== 'https:') {
    throw new AppError(400, 'Only HTTPS links are supported.');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const isSupported = SUPPORTED_DOMAINS.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  );

  if (!isSupported) {
    throw new AppError(400, 'This site is not supported yet. Try Instagram, TikTok, YouTube, X, or Facebook.');
  }

  parsed.hash = '';
  return parsed.toString();
}

function normalizeContentType(value) {
  const contentType = typeof value === 'string' ? value.toLowerCase() : 'video';
  if (!CONTENT_TYPES.has(contentType)) {
    throw new AppError(400, 'Choose a supported media type.');
  }
  return contentType;
}

function imageExtension(format) {
  if (!IMAGE_FORMATS.has(format)) {
    throw new AppError(400, 'Choose a supported image format.');
  }
  return format === 'jpeg' ? 'jpg' : format;
}

function downloadOptions(format, quality, outputTemplate) {
  if (!['mp4', 'mp3', 'webm'].includes(format)) {
    throw new AppError(400, 'Choose a supported file format.');
  }

  if (format === 'mp3') {
    if (!AUDIO_QUALITIES.has(quality)) {
      throw new AppError(400, 'Choose a supported audio quality.');
    }

    return {
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: `${quality}K`,
      format: 'bestaudio/best',
      output: outputTemplate,
      ffmpegLocation: ffmpegPath,
      maxFilesize: MAX_FILE_SIZE,
      noPlaylist: true,
      noProgress: true,
      noWarnings: true,
      quiet: true,
      retries: 2,
      socketTimeout: 20
    };
  }

  if (!VIDEO_QUALITIES.has(quality)) {
    throw new AppError(400, 'Choose a supported video quality.');
  }

  const heightFilter = quality === 'best' ? '' : `[height<=${quality}]`;
  const audioExtension = format === 'mp4' ? 'm4a' : 'webm';
  const selector = [
    `bv*[ext=${format}]${heightFilter}+ba[ext=${audioExtension}]`,
    `b[ext=${format}]${heightFilter}`,
    `bv*${heightFilter}+ba`,
    `b${heightFilter}`
  ].join('/');

  return {
    format: selector,
    mergeOutputFormat: format,
    remuxVideo: format,
    output: outputTemplate,
    ffmpegLocation: ffmpegPath,
    maxFilesize: MAX_FILE_SIZE,
    noPlaylist: true,
    noProgress: true,
    noWarnings: true,
    quiet: true,
    retries: 2,
    socketTimeout: 20
  };
}

function imageDownloadOptions(format, contentType, outputTemplate) {
  const convertedFormat = imageExtension(format);
  if (contentType !== 'post' && contentType !== 'carousel') {
    throw new AppError(400, 'Image downloads require a post or carousel media type.');
  }

  const options = {
    skipDownload: true,
    writeThumbnail: true,
    convertThumbnails: convertedFormat,
    output: outputTemplate,
    ffmpegLocation: ffmpegPath,
    noProgress: true,
    noWarnings: true,
    quiet: true,
    retries: 2,
    socketTimeout: 20
  };

  if (contentType === 'carousel') {
    options.yesPlaylist = true;
    options.playlistEnd = 20;
  } else {
    options.noPlaylist = true;
  }
  return options;
}

function runYtDlp(url, flags, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(YT_DLP_PATH, [url, ...youtubeDlPackage.args(flags)], {
      shell: false,
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let outputExceeded = false;
    let timedOut = false;
    const stdoutLimit = flags.dumpSingleJson ? 16 * 1024 * 1024 : 1024 * 1024;
    const stderrLimit = 2 * 1024 * 1024;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdoutSize += chunk.length;
      if (stdoutSize > stdoutLimit) {
        outputExceeded = true;
        child.kill();
        return;
      }
      stdout.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderrSize += chunk.length;
      if (stderrSize <= stderrLimit) stderr.push(chunk);
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (exitCode) => {
      clearTimeout(timeout);
      const stderrText = Buffer.concat(stderr).toString('utf8').trim();
      if (timedOut) {
        reject(Object.assign(new Error('Media extraction timed out.'), { stderr: stderrText }));
        return;
      }
      if (outputExceeded) {
        reject(Object.assign(new Error('Media extractor output was too large.'), { stderr: stderrText }));
        return;
      }
      if (exitCode !== 0) {
        reject(Object.assign(new Error(stderrText || 'Media extraction failed.'), { stderr: stderrText }));
        return;
      }

      const stdoutText = Buffer.concat(stdout).toString('utf8').trim();
      try {
        resolve(flags.dumpSingleJson ? JSON.parse(stdoutText) : stdoutText);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      if (tooLarge) {
        reject(new AppError(413, 'Request is too large.'));
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new AppError(400, 'Request body must be valid JSON.'));
      }
    });

    request.on('error', reject);
  });
}

function safeText(value, fallback = '', maxLength = 180) {
  if (typeof value !== 'string') return fallback;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return text.slice(0, maxLength) || fallback;
}

function safeThumbnail(value) {
  if (typeof value !== 'string') return '';
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function safeFilename(value) {
  const filename = safeText(value, 'social-media', 90)
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/[. ]+$/g, '')
    .trim();
  return filename || 'social-media';
}

function downloaderMessage(error) {
  const detail = `${error?.stderr || ''} ${error?.message || ''}`.toLowerCase();
  if (detail.includes('unsupported url')) return 'This link is not supported by the media extractor.';
  if (detail.includes('private') || detail.includes('login') || detail.includes('sign in')) {
    return 'This media is private or requires an account. Only public links can be downloaded.';
  }
  if (detail.includes('copyright') || detail.includes('unavailable')) {
    return 'This media is unavailable or restricted by the platform.';
  }
  if (detail.includes('max-filesize') || detail.includes('larger than max-filesize')) {
    return 'This file is larger than the 250 MB download limit.';
  }
  return 'Could not process this link. The site may have changed or blocked the request.';
}

async function serveStatic(response, pathname) {
  const staticFile = STATIC_FILES.get(pathname);
  if (!staticFile) return false;

  const [filename, contentType] = staticFile;
  const contents = await fsp.readFile(path.join(__dirname, filename));
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': contents.length,
    'Cache-Control': pathname === '/' || pathname === '/index.html' ? 'no-cache' : 'public, max-age=3600',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  response.end(contents);
  return true;
}

async function mediaInfo(request, response) {
  const body = await readJson(request);
  const url = validateMediaUrl(body.url);
  const contentType = normalizeContentType(body.contentType);

  let output;
  try {
    const options = {
      dumpSingleJson: true,
      noWarnings: true,
      quiet: true,
      retries: 1,
      socketTimeout: 15
    };
    if (contentType === 'carousel') {
      options.yesPlaylist = true;
      options.playlistEnd = 20;
    } else {
      options.noPlaylist = true;
    }
    output = await runYtDlp(url, options, 60 * 1000);
  } catch (error) {
    throw new AppError(422, downloaderMessage(error));
  }

  const entries = Array.isArray(output.entries) ? output.entries.filter(Boolean) : [];
  const info = contentType === 'carousel' && entries.length ? entries[0] : output;
  const thumbnailData = Array.isArray(info.thumbnails)
    ? [...info.thumbnails].reverse().find((thumbnail) => safeThumbnail(thumbnail?.url))
    : null;
  const width = Number(info.width || thumbnailData?.width);
  const height = Number(info.height || thumbnailData?.height);
  sendJson(response, 200, {
    title: safeText(output.title || info.title, 'Untitled media'),
    uploader: safeText(output.uploader || output.channel || info.uploader || info.channel, '', 80),
    platform: safeText(output.extractor_key || output.extractor || info.extractor_key || info.extractor, 'Media', 40),
    duration: Number.isFinite(Number(info.duration)) ? Number(info.duration) : null,
    thumbnail: safeThumbnail(info.thumbnail || thumbnailData?.url),
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
    itemCount: contentType === 'carousel' ? Math.max(entries.length, 1) : 1
  });
}

async function downloadMedia(request, response) {
  if (activeDownloads >= MAX_ACTIVE_DOWNLOADS) {
    throw new AppError(429, 'Two downloads are already running. Try again in a moment.');
  }

  activeDownloads += 1;
  let tempDirectory = '';

  try {
    const body = await readJson(request);
    const url = validateMediaUrl(body.url);
    const contentType = normalizeContentType(body.contentType);
    const format = typeof body.format === 'string' ? body.format.toLowerCase() : '';
    const quality = typeof body.quality === 'string' ? body.quality.toLowerCase() : '';
    tempDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'social-ripper-'));
    const isImageDownload = contentType !== 'video';
    const outputTemplate = path.join(
      tempDirectory,
      isImageDownload ? 'image-%(autonumber)03d.%(ext)s' : 'media.%(ext)s'
    );
    const options = isImageDownload
      ? imageDownloadOptions(format, contentType, outputTemplate)
      : downloadOptions(format, quality, outputTemplate);

    try {
      await runYtDlp(url, options, 10 * 60 * 1000);
    } catch (error) {
      throw new AppError(422, downloaderMessage(error));
    }

    const entries = await fsp.readdir(tempDirectory, { withFileTypes: true });
    const convertedExtension = isImageDownload ? imageExtension(format) : '';
    const outputs = entries.filter(
      (entry) => entry.isFile()
        && !entry.name.endsWith('.part')
        && !entry.name.endsWith('.ytdl')
        && (!isImageDownload || path.extname(entry.name).slice(1).toLowerCase() === convertedExtension)
    );
    if (!outputs.length) {
      const message = isImageDownload
        ? 'No downloadable images were found in this post.'
        : 'The media extractor did not create a file.';
      throw new AppError(422, message);
    }

    const files = await Promise.all(outputs.map(async (output) => {
      const filePath = path.join(tempDirectory, output.name);
      return { filePath, name: output.name, stats: await fsp.stat(filePath) };
    }));
    const totalSize = files.reduce((total, file) => total + file.stats.size, 0);
    if (totalSize > MAX_FILE_BYTES) {
      throw new AppError(413, 'This file is larger than the 250 MB download limit.');
    }

    const baseName = safeFilename(body.title);
    if (contentType === 'carousel') {
      const { ZipArchive } = await import('archiver');
      const archive = new ZipArchive({ zlib: { level: 9 } });
      const cleanup = () => fsp.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});

      response.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${baseName}-${format}-carousel.zip"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });

      archive.on('warning', (error) => {
        if (error.code !== 'ENOENT') response.destroy(error);
      });
      archive.on('error', (error) => response.destroy(error));
      response.on('close', () => {
        archive.abort();
        cleanup();
      });
      archive.pipe(response);
      files
        .sort((first, second) => first.name.localeCompare(second.name))
        .forEach((file, index) => {
          const number = String(index + 1).padStart(2, '0');
          archive.file(file.filePath, { name: `${number}.${format}` });
        });
      await archive.finalize();
      return;
    }

    const output = files[0];
    const extension = isImageDownload
      ? format
      : path.extname(output.name).slice(1).toLowerCase() || format;
    const contentTypes = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      mp3: 'audio/mpeg',
      mp4: 'video/mp4',
      webm: 'video/webm',
      m4a: 'audio/mp4'
    };
    const downloadName = `${baseName}.${extension}`;

    response.writeHead(200, {
      'Content-Type': contentTypes[extension] || 'application/octet-stream',
      'Content-Length': output.stats.size,
      'Content-Disposition': `attachment; filename="${downloadName}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });

    const stream = fs.createReadStream(output.filePath);
    const cleanup = () => fsp.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
    stream.on('error', () => response.destroy());
    stream.on('close', cleanup);
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  } catch (error) {
    if (tempDirectory) {
      await fsp.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  } finally {
    activeDownloads -= 1;
  }
}

function createServer() {
  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, 'http://localhost');

      if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
        sendJson(response, 200, { status: 'ok' });
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/info') {
        await mediaInfo(request, response);
        return;
      }

      if (request.method === 'POST' && requestUrl.pathname === '/api/download') {
        await downloadMedia(request, response);
        return;
      }

      if (request.method === 'GET' && await serveStatic(response, requestUrl.pathname)) return;
      sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }

      const statusCode = error instanceof AppError ? error.statusCode : 500;
      const message = error instanceof AppError ? error.message : 'Unexpected server error.';
      if (!(error instanceof AppError)) console.error(error);
      sendJson(response, statusCode, { error: message });
    }
  });

  server.requestTimeout = 10 * 60 * 1000;
  server.headersTimeout = 30 * 1000;
  return server;
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`Social Ripper is running at http://${HOST}:${PORT}`);
  });
}

module.exports = { createServer, downloadOptions, imageDownloadOptions, validateMediaUrl };
