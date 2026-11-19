const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const {
  AppError, downloadImages, findExecutable, getMediaTools,
  inspectImages, parseToolJson, requireTool, runYtDlp
} = require('./media-tools');

function parsePort(value, fallback = 3000) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) throw new RangeError(`Invalid port: ${value}`);
  const port = Number.parseInt(raw, 10);
  if (port < 0 || port > 65535) throw new RangeError(`Port out of range: ${value}`);
  return port;
}

function parsePositiveInt(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return parsed > 0 ? parsed : fallback;
}

function parseAllowedHosts(value = '') {
  return new Set(
    String(value)
      .split(',')
      .map((entry) => entry.trim().toLowerCase().replace(/\.$/, ''))
      .filter(Boolean)
  );
}

const PORT = parsePort(process.env.PORT, 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DEFAULT_ALLOWED_HOSTS = parseAllowedHosts(process.env.ALLOWED_HOSTS);
const DOWNLOAD_TIMEOUT_MS = parsePositiveInt(process.env.DOWNLOAD_TIMEOUT_MS, 60 * 60_000);
const PENDING_DOWNLOAD_TTL_MS = parsePositiveInt(process.env.PENDING_DOWNLOAD_TTL_MS, 60_000);
const INFO_CACHE_TTL_MS = 5 * 60_000;
const INFO_CACHE_MAX_ENTRIES = 25;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_ACTIVE_JOBS = 2;

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
  'threads.com',
  'vimeo.com',
  'reddit.com',
  'redd.it',
  'pinterest.com',
  'pin.it'
];

const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/share-target', ['index.html', 'text/html; charset=utf-8']],
  ['/social-ripper.css', ['social-ripper.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
  ['/icons/icon-192.png', ['icons/icon-192.png', 'image/png']],
  ['/icons/icon-512.png', ['icons/icon-512.png', 'image/png']],
  ['/icons/icon-maskable-512.png', ['icons/icon-maskable-512.png', 'image/png']],
  ['/icons/apple-touch-icon.png', ['icons/apple-touch-icon.png', 'image/png']]
]);
const NO_CACHE_PATHS = new Set(['/', '/index.html', '/share-target', '/sw.js', '/manifest.webmanifest']);

const VIDEO_QUALITIES = new Set(['best', '1080', '720', '480']);
const AUDIO_QUALITIES = new Set(['320', '192', '128']);
const CONTENT_TYPES = new Set(['video', 'post', 'carousel']);
const IMAGE_FORMATS = new Set(['jpg', 'jpeg', 'png', 'webp']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]']);

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

function downloadOptions(format, quality, outputTemplate, { trackProgress = false, loadInfoJson = null } = {}) {
  if (!['mp4', 'mp3', 'webm'].includes(format)) {
    throw new AppError(400, 'Choose a supported file format.');
  }

  const shared = {
    output: outputTemplate,
    forceIpv4: true,
    concurrentFragments: 4,
    noPlaylist: true,
    playlistEnd: 1,
    noWarnings: true,
    quiet: true,
    retries: 2,
    socketTimeout: 20
  };
  if (trackProgress) {
    shared.progress = true;
    shared.newline = true;
    shared.progressTemplate = 'download:SR_PROGRESS:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s';
  } else {
    shared.noProgress = true;
  }
  if (loadInfoJson) {
    shared.loadInfoJson = loadInfoJson;
  }

  if (format === 'mp3') {
    if (!AUDIO_QUALITIES.has(quality)) {
      throw new AppError(400, 'Choose a supported audio quality.');
    }

    return {
      ...shared,
      extractAudio: true,
      audioFormat: 'mp3',
      audioQuality: `${quality}K`,
      format: 'bestaudio/best'
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

  if (format === 'mp4') {
    return {
      ...shared,
      format: selector,
      formatSort: 'ext:mp4:m4a,vcodec:h264',
      mergeOutputFormat: 'mp4',
      remuxVideo: 'mp4'
    };
  }

  return {
    ...shared,
    format: selector,
    formatSort: 'ext:webm,vcodec:vp9',
    mergeOutputFormat: 'webm/mkv',
    recodeVideo: 'webm',
    postprocessorArgs: 'VideoConvertor+ffmpeg_o:-deadline realtime -cpu-used 4'
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

function requireSameOrigin(request, { boundHost = HOST, allowedHosts = DEFAULT_ALLOWED_HOSTS } = {}) {
  const { host, origin, 'sec-fetch-site': fetchSite } = request.headers;
  const localOrigin = host && URL.canParse(`http://${host}`) ? new URL(`http://${host}`) : null;
  if (!host || !localOrigin || localOrigin.host !== host.toLowerCase().replace(/:80$/, '')) {
    throw new AppError(403, 'This request must come from the Social Ripper page.');
  }

  const hostname = localOrigin.hostname;
  const normalizedBound = boundHost.trim().toLowerCase();
  const configuredHost = normalizedBound.includes(':') && !normalizedBound.startsWith('[')
    ? `[${normalizedBound}]`
    : normalizedBound;
  const isWildcard = WILDCARD_HOSTS.has(normalizedBound);
  const isIpHost = net.isIP(hostname.replace(/^\[|\]$/g, '')) !== 0;

  const isAllowedHost = LOCAL_HOSTS.has(hostname)
    || (!isWildcard && hostname === configuredHost)
    || allowedHosts.has(hostname)
    || (isWildcard && isIpHost);

  const originAllowed = !origin
    || origin === localOrigin.origin
    || (allowedHosts.has(hostname) && origin === `https://${localOrigin.host}`);

  if (!isAllowedHost || fetchSite === 'cross-site' || fetchSite === 'same-site' || !originAllowed) {
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

function safeUnicodeFilename(value) {
  const filename = safeText(value, 'social-media', 90)
    .normalize('NFC')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/[. ]+$/g, '')
    .trim();
  return filename || 'social-media';
}

function encodeRFC5987(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function contentDisposition(title, extension, suffix = '') {
  const ascii = `${safeFilename(title)}${suffix}.${extension}`;
  const unicode = `${safeUnicodeFilename(title)}${suffix}.${extension}`;
  const header = unicode === ascii
    ? `attachment; filename="${ascii}"`
    : `attachment; filename="${ascii}"; filename*=UTF-8''${encodeRFC5987(unicode)}`;
  return { filename: unicode, header };
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
  return 'Could not process this link. The site may have changed or blocked the request.';
}

async function extractMedia(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppError || error.name === 'AbortError') throw error;
    throw new AppError(422, downloaderMessage(error));
  }
}

async function serveStatic(response, pathname) {
  const staticFile = STATIC_FILES.get(pathname);
  if (!staticFile) return false;

  const [filename, contentType] = staticFile;
  const contents = await fsp.readFile(path.join(__dirname, filename));
  const headers = {
    'Content-Type': contentType,
    'Content-Length': contents.length,
    'Cache-Control': NO_CACHE_PATHS.has(pathname) ? 'no-cache' : 'public, max-age=3600',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  };
  if (pathname === '/sw.js') {
    headers['Service-Worker-Allowed'] = '/';
  }
  response.writeHead(200, headers);
  response.end(contents);
  return true;
}

async function inspectVideo(tools, url, signal) {
  const options = {
    dumpSingleJson: true,
    forceIpv4: true,
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
    metadata: {
      title: info.title,
      uploader: info.uploader || info.channel,
      platform: info.extractor_key || info.extractor,
      duration: info.duration,
      thumbnail: safeThumbnail(info.thumbnail) || safeThumbnail(thumbnailData?.url),
      width: info.width || thumbnailData?.width,
      height: info.height || thumbnailData?.height,
      itemCount: 1
    },
    rawJson: output
  };
}

function buildMetadata(info) {
  const width = Number(info.width);
  const height = Number(info.height);
  return {
    title: safeText(info.title, 'Untitled media'),
    uploader: safeText(info.uploader, '', 80),
    platform: safeText(info.platform, 'Media', 40),
    duration: Number.isFinite(info.duration) ? info.duration : null,
    thumbnail: safeThumbnail(info.thumbnail),
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : null,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : null,
    itemCount: info.itemCount
  };
}

async function mediaInfo(response, { url, contentType, tools, signal, saveCache = null }) {
  const extracted = await extractMedia(() => contentType === 'video'
    ? inspectVideo(tools, url, signal)
    : inspectImages(tools, url, contentType, signal));
  const rawInfo = contentType === 'video' ? extracted.metadata : extracted;
  const metadata = buildMetadata(rawInfo);
  saveCache?.({
    metadata,
    rawJson: contentType === 'video' ? extracted.rawJson : null
  });
  sendJson(response, 200, metadata);
}

function createProgressReporter(onProgress) {
  if (!onProgress) return null;
  let lastEmit = 0;
  let lastPercent = -1;

  return (line) => {
    const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!clean.startsWith('SR_PROGRESS:')) return;

    const [percentRaw = '', speedRaw = '', etaRaw = ''] = clean.slice('SR_PROGRESS:'.length).split('|');
    const parsedPercent = Number.parseFloat(percentRaw.replace('%', '').trim());
    const percent = Number.isFinite(parsedPercent) ? Math.max(0, Math.min(100, parsedPercent)) : null;
    const speedText = speedRaw.trim();
    const etaText = etaRaw.trim();
    const speed = speedText && !/^(n\/a|unknown)$/i.test(speedText) ? speedText : '';
    const eta = etaText && !/^(n\/a|unknown)$/i.test(etaText) ? etaText : '';

    const now = Date.now();
    if (now - lastEmit < 200 && percent !== 100 && lastPercent !== -1) return;
    lastEmit = now;
    if (percent !== null) lastPercent = percent;
    onProgress({ stage: 'downloading', percent, speed, eta });
  };
}

async function downloadVideo(
  tools,
  url,
  format,
  quality,
  directory,
  signal,
  timeoutMs,
  { cachedRawJson = null, invalidateCache = null, onProgress = null } = {}
) {
  const template = path.join(directory, 'media.%(ext)s');
  const ffmpegLocation = await requireTool(tools, 'ffmpeg');
  const progressReporter = createProgressReporter(onProgress);
  const deadline = Date.now() + timeoutMs;

  async function runOnce(loadInfoJson) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new AppError(504, 'Media processing timed out.');
    const options = downloadOptions(format, quality, template, {
      trackProgress: Boolean(progressReporter),
      loadInfoJson
    });
    options.ffmpegLocation = ffmpegLocation;
    const { diagnostic } = await runYtDlp(tools, url, options, {
      signal,
      timeoutMs: remainingMs,
      onLine: progressReporter
    });

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

  if (!cachedRawJson) {
    return runOnce(null);
  }

  const infoJsonPath = path.join(directory, 'info.json');
  await fsp.writeFile(infoJsonPath, cachedRawJson, 'utf8');
  try {
    try {
      return await runOnce(infoJsonPath);
    } catch (error) {
      if (error.name === 'AbortError' || (error instanceof AppError && (error.statusCode === 503 || error.statusCode === 504))) {
        throw error;
      }
      invalidateCache?.();
      const entries = await fsp.readdir(directory);
      await Promise.all(entries.map((entry) => fsp.rm(path.join(directory, entry), { recursive: true, force: true })));
      onProgress?.({ stage: 'starting' });
      return await runOnce(null);
    }
  } finally {
    await fsp.rm(infoJsonPath, { force: true }).catch(() => {});
  }
}

async function streamCarousel(response, files, dispositionHeader, extension, signal) {
  const { ZipArchive } = await import('archiver');
  signal.throwIfAborted();
  const archive = new ZipArchive({ store: true });
  archive.on('warning', (error) => archive.destroy(error));

  response.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': dispositionHeader,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });

  try {
    files.forEach((file, index) => {
      const number = String(index + 1).padStart(2, '0');
      archive.file(file.filePath, { name: `${number}.${extension}` });
    });
    await Promise.all([
      pipeline(archive, response, { signal }),
      archive.finalize()
    ]);
  } finally {
    archive.abort();
  }
}

function validateDownloadParams(contentType, body) {
  const format = typeof body.format === 'string' ? body.format.toLowerCase() : '';
  const quality = typeof body.quality === 'string' ? body.quality.toLowerCase() : '';
  const extension = contentType === 'video' ? format : imageExtension(format);
  if (contentType === 'video') {
    downloadOptions(format, quality, 'validate.%(ext)s');
  }
  return { format, quality, extension };
}

async function prepareDownload({
  body,
  url,
  contentType,
  tools,
  signal,
  downloadTimeoutMs,
  removeDirectory,
  cachedRawJson = null,
  invalidateCache = null,
  onProgress = null
}) {
  const { format, quality, extension } = validateDownloadParams(contentType, body);

  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'social-ripper-'));
  try {
    const files = await extractMedia(() => contentType === 'video'
      ? downloadVideo(tools, url, format, quality, directory, signal, downloadTimeoutMs, {
          cachedRawJson,
          invalidateCache,
          onProgress
        })
      : downloadImages(tools, url, contentType, extension, {
          directory,
          signal,
          timeoutMs: downloadTimeoutMs,
          onProgress
        }));
    signal.throwIfAborted();

    const disposition = contentType === 'carousel'
      ? contentDisposition(body.title, 'zip', `-${extension}-carousel`)
      : contentDisposition(body.title, extension);

    return {
      directory,
      files,
      contentType,
      extension,
      filename: disposition.filename,
      dispositionHeader: disposition.header,
      size: contentType === 'carousel' ? null : files[0].stats.size
    };
  } catch (error) {
    await removeDirectory(directory);
    throw error;
  }
}

async function streamPreparedDownload(response, prepared, signal) {
  if (prepared.contentType === 'carousel') {
    await streamCarousel(response, prepared.files, prepared.dispositionHeader, prepared.extension, signal);
    return;
  }

  const [output] = prepared.files;
  const contentTypes = {
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    webm: 'video/webm'
  };

  response.writeHead(200, {
    'Content-Type': contentTypes[prepared.extension],
    'Content-Length': output.stats.size,
    'Content-Disposition': prepared.dispositionHeader,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  await pipeline(fs.createReadStream(output.filePath), response, { signal });
}

async function mediaHealth(tools) {
  const entries = await Promise.all(Object.entries(tools).map(async ([name, candidates]) => [
    name, await findExecutable(candidates) !== null
  ]));
  return Object.fromEntries(entries);
}

function createServer({
  tools = getMediaTools(),
  host = HOST,
  allowedHosts = DEFAULT_ALLOWED_HOSTS,
  downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS,
  pendingDownloadTtlMs = PENDING_DOWNLOAD_TTL_MS,
  infoCacheTtlMs = INFO_CACHE_TTL_MS,
  infoCacheMaxEntries = INFO_CACHE_MAX_ENTRIES
} = {}) {
  const normalizedAllowedHosts = allowedHosts instanceof Set
    ? new Set([...allowedHosts].map((entry) => String(entry).trim().toLowerCase().replace(/\.$/, '')).filter(Boolean))
    : parseAllowedHosts(allowedHosts);

  let activeJobs = 0;
  let shuttingDown = false;
  const activeControllers = new Set();
  const activeJobPromises = new Set();
  const pendingDownloads = new Map();
  const cleanupPromises = new Set();
  const infoCache = new Map();

  function getCachedInfo(key) {
    const entry = infoCache.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      infoCache.delete(key);
      return null;
    }
    return entry;
  }

  function setCachedInfo(key, entry) {
    if (infoCacheMaxEntries <= 0 || infoCacheTtlMs <= 0) return;
    infoCache.delete(key);
    while (infoCache.size >= infoCacheMaxEntries) {
      const oldestKey = infoCache.keys().next().value;
      infoCache.delete(oldestKey);
    }
    infoCache.set(key, { ...entry, expiresAt: Date.now() + infoCacheTtlMs });
  }

  function removeDirectory(directory) {
    const promise = fsp.rm(directory, { recursive: true, force: true, maxRetries: 3 })
      .catch((error) => {
        console.error('Could not clean up temporary media:', error.message);
      })
      .finally(() => {
        cleanupPromises.delete(promise);
      });
    cleanupPromises.add(promise);
    return promise;
  }

  function acquireSlot(response) {
    if (shuttingDown) {
      throw new AppError(503, 'Server is shutting down.');
    }
    if (activeJobs >= MAX_ACTIVE_JOBS) {
      throw new AppError(429, 'Two media jobs are already running. Try again in a moment.');
    }

    const controller = new AbortController();
    const abort = () => {
      if (!response.writableFinished) controller.abort();
    };
    response.once('close', abort);
    activeControllers.add(controller);
    activeJobs += 1;

    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        activeJobs -= 1;
      }
    };

    const detach = () => {
      activeControllers.delete(controller);
      response.removeListener('close', abort);
    };

    return { controller, release, detach };
  }

  function trackJob(promise) {
    activeJobPromises.add(promise);
    return promise.finally(() => {
      activeJobPromises.delete(promise);
    });
  }

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

      const downloadMatch = request.method === 'GET'
        ? requestUrl.pathname.match(/^\/api\/downloads\/([A-Za-z0-9_-]{16,128})$/)
        : null;
      if (downloadMatch) {
        requireSameOrigin(request, { boundHost: host, allowedHosts: normalizedAllowedHosts });
        const token = downloadMatch[1];
        const entry = pendingDownloads.get(token);
        if (!entry) {
          throw new AppError(404, 'This download link has expired or already been used.');
        }
        pendingDownloads.delete(token);
        clearTimeout(entry.timer);

        if (shuttingDown || response.destroyed || response.socket?.destroyed) {
          await removeDirectory(entry.prepared.directory);
          entry.release();
          if (shuttingDown) throw new AppError(503, 'Server is shutting down.');
          return;
        }

        const controller = new AbortController();
        const abort = () => {
          if (!response.writableFinished) controller.abort();
        };
        response.once('close', abort);
        activeControllers.add(controller);

        await trackJob((async () => {
          try {
            await streamPreparedDownload(response, entry.prepared, controller.signal);
          } finally {
            activeControllers.delete(controller);
            response.removeListener('close', abort);
            await removeDirectory(entry.prepared.directory);
            entry.release();
          }
        })());
        return;
      }

      if (request.method === 'POST' && ['/api/info', '/api/download', '/api/downloads'].includes(requestUrl.pathname)) {
        requireSameOrigin(request, { boundHost: host, allowedHosts: normalizedAllowedHosts });
        const body = await readJson(request);
        const url = validateMediaUrl(body.url);
        const contentType = normalizeContentType(body.contentType);
        if (response.destroyed || response.socket?.destroyed) return;

        const cacheKey = `${contentType}:${url}`;

        if (requestUrl.pathname === '/api/info') {
          if (shuttingDown) throw new AppError(503, 'Server is shutting down.');
          const cached = getCachedInfo(cacheKey);
          if (cached) {
            sendJson(response, 200, cached.metadata);
            return;
          }

          const { controller, release, detach } = acquireSlot(response);
          await trackJob((async () => {
            try {
              await mediaInfo(response, {
                url,
                contentType,
                tools,
                signal: controller.signal,
                saveCache: (entry) => setCachedInfo(cacheKey, entry)
              });
            } finally {
              detach();
              release();
            }
          })());
          return;
        }

        validateDownloadParams(contentType, body);
        const cached = contentType === 'video' ? getCachedInfo(cacheKey) : null;
        const { controller, release, detach } = acquireSlot(response);

        if (requestUrl.pathname === '/api/download') {
          await trackJob((async () => {
            try {
              const prepared = await prepareDownload({
                body,
                url,
                contentType,
                tools,
                signal: controller.signal,
                downloadTimeoutMs,
                removeDirectory,
                cachedRawJson: cached?.rawJson || null,
                invalidateCache: () => infoCache.delete(cacheKey)
              });
              try {
                await streamPreparedDownload(response, prepared, controller.signal);
              } finally {
                await removeDirectory(prepared.directory);
              }
            } finally {
              detach();
              release();
            }
          })());
          return;
        }

        // POST /api/downloads prepares media and returns a one-time URL for native browser streaming.
        const wantsProgress = (request.headers.accept || '').toLowerCase().includes('application/x-ndjson');
        await trackJob((async () => {
          let handedOff = false;
          let sendEvent = null;
          if (wantsProgress) {
            response.writeHead(200, {
              'Content-Type': 'application/x-ndjson; charset=utf-8',
              'Cache-Control': 'no-store',
              'X-Accel-Buffering': 'no'
            });
            sendEvent = (payload) => {
              if (!response.destroyed && !response.writableEnded) {
                response.write(`${JSON.stringify(payload)}\n`);
              }
            };
            sendEvent({ stage: 'starting' });
          }

          try {
            const prepared = await prepareDownload({
              body,
              url,
              contentType,
              tools,
              signal: controller.signal,
              downloadTimeoutMs,
              removeDirectory,
              cachedRawJson: cached?.rawJson || null,
              invalidateCache: () => infoCache.delete(cacheKey),
              onProgress: sendEvent
            });
            if (shuttingDown || controller.signal.aborted) {
              await removeDirectory(prepared.directory);
              controller.signal.throwIfAborted();
              throw new AppError(503, 'Server is shutting down.');
            }

            const token = crypto.randomBytes(24).toString('base64url');
            const timer = setTimeout(() => {
              const expired = pendingDownloads.get(token);
              if (!expired) return;
              pendingDownloads.delete(token);
              removeDirectory(expired.prepared.directory).finally(expired.release);
            }, pendingDownloadTtlMs);
            timer.unref?.();

            pendingDownloads.set(token, { prepared, timer, release });
            handedOff = true;
            const readyPayload = {
              downloadUrl: `/api/downloads/${token}`,
              filename: prepared.filename,
              size: prepared.size
            };
            if (wantsProgress) {
              if (!response.destroyed && !response.writableEnded) {
                response.end(`${JSON.stringify({ stage: 'ready', ...readyPayload })}\n`);
              }
            } else {
              sendJson(response, 200, readyPayload);
            }
          } catch (error) {
            if (!wantsProgress) throw error;
            if (error.name === 'AbortError' || controller.signal.aborted || response.destroyed) {
              return;
            }
            const message = error instanceof AppError ? error.message : 'Unexpected server error.';
            if (!(error instanceof AppError)) console.error(error);
            if (!response.writableEnded) {
              response.end(`${JSON.stringify({ stage: 'error', error: message })}\n`);
            }
          } finally {
            detach();
            if (!handedOff) release();
          }
        })());
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

  server.shutdown = async () => {
    if (!shuttingDown) {
      shuttingDown = true;

      for (const controller of activeControllers) {
        controller.abort(new AppError(503, 'Server is shutting down.'));
      }

      for (const [token, entry] of pendingDownloads.entries()) {
        pendingDownloads.delete(token);
        clearTimeout(entry.timer);
        removeDirectory(entry.prepared.directory).finally(entry.release);
      }

      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    }

    await Promise.allSettled([...activeJobPromises, ...cleanupPromises]);
  };

  return server;
}

if (require.main === module) {
  const server = createServer();
  let shuttingDownProcess = false;
  const handleSignal = (signalName) => {
    if (shuttingDownProcess) return;
    shuttingDownProcess = true;
    const forceTimer = setTimeout(() => {
      console.error(`Forced exit after ${signalName} shutdown timeout.`);
      process.exit(1);
    }, 5000);
    forceTimer.unref();
    server.shutdown()
      .then(() => {
        clearTimeout(forceTimer);
        process.exit(0);
      })
      .catch((error) => {
        console.error('Error during shutdown:', error);
        process.exit(1);
      });
  };
  process.once('SIGINT', () => handleSignal('SIGINT'));
  process.once('SIGTERM', () => handleSignal('SIGTERM'));

  server.listen(PORT, HOST, () => {
    const address = server.address();
    const displayHost = HOST.includes(':') && !HOST.startsWith('[') ? `[${HOST}]` : HOST;
    console.log(`Social Ripper is running at http://${displayHost}:${address.port}`);
  });
}

module.exports = { contentDisposition, createServer, downloadOptions, parsePort, validateMediaUrl };
