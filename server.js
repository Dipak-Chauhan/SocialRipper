const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const {
  AppError, checkFileBudget, downloadImages, findExecutable, getMediaTools,
  inspectImages, parseToolJson, requireTool, runYtDlp
} = require('./media-tools');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY_BYTES = 16 * 1024;
const MAX_ACTIVE_JOBS = 2;
const MAX_FILE_SIZE = '250M';

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
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MEDIA_HANDLERS = { '/api/info': mediaInfo, '/api/download': downloadMedia };

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
  if (parsed.username || parsed.password || parsed.port) {
    throw new AppError(400, 'Use a public HTTPS link without credentials or a custom port.');
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
      maxFilesize: MAX_FILE_SIZE,
      noPlaylist: true,
      playlistEnd: 1,
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
    maxFilesize: MAX_FILE_SIZE,
    noPlaylist: true,
    playlistEnd: 1,
    noProgress: true,
    noWarnings: true,
    quiet: true,
    retries: 2,
    socketTimeout: 20
  };
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
  const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new AppError(415, 'Send an application/json request body.');
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        if (!tooLarge) {
          tooLarge = true;
          reject(new AppError(413, 'Request is too large.'));
        }
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      if (tooLarge) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        reject(new AppError(400, 'Request body must be valid JSON.'));
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        reject(new AppError(400, 'Request body must be a JSON object.'));
        return;
      }
      resolve(body);
    });

    request.on('error', reject);
  });
}

function requireSameOrigin(request) {
  const { host, origin, 'sec-fetch-site': fetchSite } = request.headers;
  const localOrigin = URL.canParse(`http://${host}`) ? new URL(`http://${host}`) : null;
  const configuredHost = HOST.includes(':') && !HOST.startsWith('[') ? `[${HOST}]` : HOST;
  if (!host || !localOrigin || localOrigin.host !== host.toLowerCase().replace(/:80$/, '')
      || (!LOCAL_HOSTS.has(localOrigin.hostname) && localOrigin.hostname !== configuredHost.toLowerCase())
      || fetchSite === 'cross-site' || fetchSite === 'same-site'
      || (origin && origin !== localOrigin.origin)) {
    throw new AppError(403, 'This request must come from the Social Ripper page.');
  }
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
  const detail = error.message.toLowerCase();
  if (detail.includes('unsupported url') || detail.includes('no suitable extractor')) {
    return 'This link is not supported by the media extractor.';
  }
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

async function extractMedia(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppError || error.name === 'AbortError') throw error;
    const message = downloaderMessage(error);
    throw new AppError(message.includes('250 MB') ? 413 : 422, message);
  }
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

async function inspectVideo(tools, url, signal) {
  const options = {
    dumpSingleJson: true,
    noWarnings: true,
    quiet: true,
    retries: 1,
    socketTimeout: 15,
    noPlaylist: true,
    playlistEnd: 1
  };
  const { output } = await runYtDlp(tools, url, options, { signal, timeoutMs: 60_000 });
  const info = parseToolJson(output, (data) => data && typeof data === 'object' && !Array.isArray(data));
  if (Array.isArray(info.entries)) throw new AppError(422, 'Use a link to an individual video.');
  const thumbnailData = Array.isArray(info.thumbnails)
    ? [...info.thumbnails].reverse().find((thumbnail) => safeThumbnail(thumbnail?.url))
    : null;
  return {
    title: info.title,
    uploader: info.uploader || info.channel,
    platform: info.extractor_key || info.extractor,
    duration: info.duration,
    thumbnail: safeThumbnail(info.thumbnail) || safeThumbnail(thumbnailData?.url),
    width: info.width || thumbnailData?.width,
    height: info.height || thumbnailData?.height,
    itemCount: 1
  };
}

async function mediaInfo(response, { url, contentType, tools, signal }) {
  const info = await extractMedia(() => contentType === 'video'
    ? inspectVideo(tools, url, signal)
    : inspectImages(tools, url, contentType, signal));
  const width = Number(info.width);
  const height = Number(info.height);
  sendJson(response, 200, {
    title: safeText(info.title, 'Untitled media'),
    uploader: safeText(info.uploader, '', 80),
    platform: safeText(info.platform, 'Media', 40),
    duration: Number.isFinite(info.duration) ? info.duration : null,
    thumbnail: safeThumbnail(info.thumbnail),
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
    itemCount: info.itemCount
  });
}

async function downloadVideo(tools, url, format, quality, directory, signal) {
  const template = path.join(directory, 'media.%(ext)s');
  const options = downloadOptions(format, quality, template);
  options.ffmpegLocation = await requireTool(tools, 'ffmpeg');
  const { diagnostic } = await runYtDlp(tools, url, options, {
    signal, directory, timeoutMs: 10 * 60_000
  });
  await checkFileBudget(directory);

  const name = 'media.' + format;
  const filePath = path.join(directory, name);
  const stats = await fsp.lstat(filePath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (!stats?.isFile() || !stats.size) {
    if (diagnostic) throw new Error(diagnostic);
    throw new AppError(422, 'The media extractor did not create the requested file.');
  }
  return [{ name, filePath, stats }];
}

async function streamCarousel(response, files, baseName, format, signal) {
  const { ZipArchive } = await import('archiver');
  signal.throwIfAborted();
  const archive = new ZipArchive({ zlib: { level: 9 } });
  archive.on('warning', (error) => archive.destroy(error));

  response.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${baseName}-${format}-carousel.zip"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });

  try {
    files.forEach((file, index) => {
      const number = String(index + 1).padStart(2, '0');
      archive.file(file.filePath, { name: `${number}.${format}` });
    });
    await Promise.all([
      pipeline(archive, response, { signal }),
      archive.finalize()
    ]);
  } finally {
    archive.abort();
  }
}

async function downloadMedia(response, { body, url, contentType, tools, signal }) {
  const format = typeof body.format === 'string' ? body.format.toLowerCase() : '';
  const quality = typeof body.quality === 'string' ? body.quality.toLowerCase() : '';
  const extension = contentType === 'video' ? format : imageExtension(format);
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'social-ripper-'));

  try {
    const files = await extractMedia(() => contentType === 'video'
      ? downloadVideo(tools, url, format, quality, directory, signal)
      : downloadImages(tools, url, contentType, extension, { directory, signal }));
    signal.throwIfAborted();

    const baseName = safeFilename(body.title);
    if (contentType === 'carousel') {
      await streamCarousel(response, files, baseName, format, signal);
      return;
    }

    const [output] = files;
    const contentTypes = {
      jpg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      mp3: 'audio/mpeg',
      mp4: 'video/mp4',
      webm: 'video/webm'
    };
    const downloadName = `${baseName}.${format}`;

    response.writeHead(200, {
      'Content-Type': contentTypes[extension],
      'Content-Length': output.stats.size,
      'Content-Disposition': `attachment; filename="${downloadName}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    await pipeline(fs.createReadStream(output.filePath), response, { signal });
  } finally {
    await fsp.rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch((error) => {
      console.error('Could not clean up temporary media:', error.message);
    });
  }
}

async function mediaHealth(tools) {
  const entries = await Promise.all(Object.entries(tools).map(async ([name, candidates]) => [
    name, await findExecutable(candidates) !== null
  ]));
  return Object.fromEntries(entries);
}

function createServer({ tools = getMediaTools() } = {}) {
  let activeJobs = 0;
  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url, 'http://localhost');

      if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
        const available = await mediaHealth(tools);
        const ready = available['yt-dlp'] && available.ffmpeg;
        sendJson(response, ready ? 200 : 503, {
          status: ready ? 'ok' : 'unavailable',
          tools: available
        });
        return;
      }

      if (request.method === 'POST' && Object.hasOwn(MEDIA_HANDLERS, requestUrl.pathname)) {
        requireSameOrigin(request);
        const body = await readJson(request);
        const url = validateMediaUrl(body.url);
        const contentType = normalizeContentType(body.contentType);
        if (response.destroyed || response.socket?.destroyed) return;

        if (activeJobs >= MAX_ACTIVE_JOBS) {
          throw new AppError(429, 'Two media jobs are already running. Try again in a moment.');
        }
        const controller = new AbortController();
        const abort = () => {
          if (!response.writableFinished) controller.abort();
        };
        response.once('close', abort);
        activeJobs += 1;
        try {
          await MEDIA_HANDLERS[requestUrl.pathname](response, { body, url, contentType, tools, signal: controller.signal });
        } finally {
          activeJobs -= 1;
          response.removeListener('close', abort);
        }
        return;
      }

      if (request.method === 'GET' && await serveStatic(response, requestUrl.pathname)) return;
      sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
      if (response.destroyed) return;
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

  server.requestTimeout = 30_000;
  server.headersTimeout = 30_000;
  return server;
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`Social Ripper is running at http://${HOST}:${PORT}`);
  });
}

module.exports = { createServer, downloadOptions, validateMediaUrl };
