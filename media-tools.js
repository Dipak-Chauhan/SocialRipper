const { execFile, spawn } = require('node:child_process');
const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ffmpegPath = require('ffmpeg-static');
const youtubeDlPackage = require('youtube-dl-exec');

const DEFAULT_YT_DLP_CACHE_DIR = path.join(os.tmpdir(), 'social-ripper-ytdlp-cache');

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif', 'tif', 'tiff', 'jxl', 'heic', 'heif']);
const MAX_IMAGES = 20;
const WINDOWS = process.platform === 'win32';

class AppError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function executableCandidates(name, override, bundled) {
  if (override) return [path.resolve(override)];
  const command = WINDOWS ? `${name}.exe` : name;
  return [
    bundled,
    path.join(__dirname, 'node_modules', '.bin', command),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, command))
  ].filter(Boolean);
}

function optionalTrimmed(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function getExtractorConfig(env = process.env) {
  const ytDlpCookiesFile = optionalTrimmed(env.YT_DLP_COOKIES_FILE);
  const galleryDlCookiesFile = optionalTrimmed(env.GALLERY_DL_COOKIES_FILE);
  return {
    ytDlp: {
      cookiesFile: ytDlpCookiesFile ? path.resolve(ytDlpCookiesFile) : null,
      proxy: optionalTrimmed(env.YT_DLP_PROXY),
      jsRuntimes: optionalTrimmed(env.YT_DLP_JS_RUNTIMES)
    },
    galleryDl: {
      cookiesFile: galleryDlCookiesFile ? path.resolve(galleryDlCookiesFile) : null,
      proxy: optionalTrimmed(env.GALLERY_DL_PROXY)
    }
  };
}

function getMediaTools() {
  return {
    'yt-dlp': executableCandidates('yt-dlp', process.env.YT_DLP_BIN, youtubeDlPackage.constants.YOUTUBE_DL_PATH),
    ffmpeg: executableCandidates('ffmpeg', process.env.FFMPEG_BIN, ffmpegPath),
    'gallery-dl': executableCandidates('gallery-dl', process.env.GALLERY_DL_BIN)
  };
}

async function findExecutable(candidates) {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, constants.X_OK);
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }
  return null;
}

async function requireTool(tools, name) {
  const executable = await findExecutable(tools[name]);
  if (!executable) throw new AppError(503, `The ${name} executable is missing. Follow the setup instructions in the README.`);
  return executable;
}

function createLineSplitter(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n|\r/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line) onLine(line);
      }
    },
    flush() {
      if (buffer) {
        onLine(buffer);
        buffer = '';
      }
    }
  };
}

function isProgressMarker(line) {
  return line.startsWith('SR_PROGRESS:') || line.startsWith('SR_STAGE:');
}

function runTool(executable, args, { name, signal, timeoutMs, largeOutput = false, onLine = null }) {
  signal.throwIfAborted();

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      detached: !WINDOWS,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    const stdout = [];
    const stderr = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let failure;
    let finished = false;
    let timeout;

    function settle(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value);
    }

    function stop(error) {
      if (finished || failure) return;
      failure = error;
      if (!child.pid) {
        settle(failure);
        return;
      }
      // yt-dlp can leave an FFmpeg subprocess running after the parent exits.
      if (WINDOWS) {
        execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, (killError) => {
          if (killError) child.kill('SIGKILL');
        });
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (killError) {
          if (killError.code !== 'ESRCH') child.kill('SIGKILL');
        }
      }
    }

    const abort = () => stop(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => stop(new AppError(504, 'Media processing timed out.')), timeoutMs);

    const pushStdout = (chunk) => {
      stdoutSize += chunk.length;
      if (stdoutSize > (largeOutput ? 16 : 1) * 1024 * 1024) {
        stop(new AppError(422, 'Media extractor output was too large.'));
        return;
      }
      stdout.push(chunk);
    };

    const pushStderr = (chunk) => {
      stderrSize += chunk.length;
      if (stderrSize <= 2 * 1024 * 1024) stderr.push(chunk);
    };

    const stdoutLines = onLine ? createLineSplitter((line) => {
      if (isProgressMarker(line)) {
        onLine(line);
        return;
      }
      onLine(line);
      pushStdout(Buffer.from(`${line}\n`));
    }) : null;

    const stderrLines = onLine ? createLineSplitter((line) => {
      if (isProgressMarker(line)) {
        onLine(line);
        return;
      }
      onLine(line);
      pushStderr(Buffer.from(`${line}\n`));
    }) : null;

    child.stdout.on('data', (chunk) => {
      if (stdoutLines) stdoutLines.push(chunk);
      else pushStdout(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderrLines) stderrLines.push(chunk);
      else pushStderr(chunk);
    });
    child.on('error', (error) => {
      const mapped = ['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code)
        ? new AppError(503, `The ${name} executable could not start. Check the media tool installation.`)
        : error;
      failure ||= mapped;
      settle(failure);
    });
    child.on('close', (exitCode) => {
      stdoutLines?.flush();
      stderrLines?.flush();
      if (failure) return settle(failure);
      const diagnostic = Buffer.concat(stderr).toString('utf8').trim();
      if (exitCode !== 0) return settle(new Error(diagnostic || `${name} failed.`));
      settle(null, { output: Buffer.concat(stdout).toString('utf8').trim(), diagnostic });
    });
  });
}

function parseToolJson(output, isValid) {
  try {
    const data = JSON.parse(output);
    if (isValid(data)) return data;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  throw new AppError(422, 'The media extractor did not return usable metadata.');
}

async function withCookiesFile(cookiesFile, toolName, signal, operation) {
  if (!cookiesFile) return operation(null);
  signal?.throwIfAborted();

  let contents;
  try {
    const stats = await fs.stat(cookiesFile);
    if (!stats.isFile()) {
      throw new Error('Not a regular file');
    }
    contents = await fs.readFile(cookiesFile);
  } catch {
    throw new AppError(503, `Configured ${toolName} cookies file could not be read.`);
  }

  // Isolate each run's cookie jar so yt-dlp write-back cannot race across jobs or fail on 0400 files.
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'social-ripper-cookies-'));
  const tempFile = path.join(tempDir, 'cookies.txt');
  try {
    await fs.writeFile(tempFile, contents, { mode: 0o600 });
    return await operation(tempFile);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

async function runYtDlp(tools, url, flags, options = {}) {
  const executable = await requireTool(tools, 'yt-dlp');
  const cacheDir = options.cacheDir || DEFAULT_YT_DLP_CACHE_DIR;
  const ytDlpConfig = options.extractorConfig?.ytDlp || {};
  return withCookiesFile(ytDlpConfig.cookiesFile, 'yt-dlp', options.signal, (cookiesFile) => {
    const args = ['--ignore-config', '--cache-dir', cacheDir];
    if (cookiesFile) args.push('--cookies', cookiesFile);
    if (ytDlpConfig.proxy) args.push('--proxy', ytDlpConfig.proxy);
    if (ytDlpConfig.jsRuntimes) args.push('--js-runtimes', ytDlpConfig.jsRuntimes);
    args.push(...youtubeDlPackage.args(flags));
    if (!flags.loadInfoJson) {
      args.push('--', url);
    }
    return runTool(executable, args, { ...options, name: 'yt-dlp', largeOutput: flags.dumpSingleJson });
  });
}

function galleryArgs(contentType, { cookiesFile = null, proxy = null } = {}) {
  const args = [
    '--config-ignore', '--no-input', '--cache-file', ':memory:', '--warning',
    '--http-timeout', '15', '--retries', '1',
    '--child-range', '1', '--child-filter', "category == 'pinterest' and subcategory == 'pinit'",
    '--post-range', '1',
    '--range', contentType === 'carousel' ? `1-${MAX_IMAGES}` : '1',
    '--filter', `extension.lower() in (${[...IMAGE_EXTENSIONS].map((ext) => `'${ext}'`).join(', ')})`
  ];
  if (cookiesFile) args.push('--cookies', cookiesFile);
  if (proxy) args.push('--proxy', proxy);
  return args;
}

async function inspectImages(tools, url, contentType, signal, { extractorConfig = null } = {}) {
  const executable = await requireTool(tools, 'gallery-dl');
  const galleryDlConfig = extractorConfig?.galleryDl || {};
  const { output } = await withCookiesFile(galleryDlConfig.cookiesFile, 'gallery-dl', signal, (cookiesFile) => {
    const args = [
      ...galleryArgs(contentType, { cookiesFile, proxy: galleryDlConfig.proxy }),
      '--resolve-json', '--', url
    ];
    return runTool(executable, args, {
      name: 'gallery-dl', signal, timeoutMs: 60_000, largeOutput: true
    });
  });
  const messages = parseToolJson(output, Array.isArray);
  const failure = messages.find((message) => message?.[0] === -1);
  if (failure) throw new Error(failure[1]?.message || 'Image extraction failed.');

  // gallery-dl data messages use 3 for a file URL and its metadata.
  const images = messages.filter((message) => message?.[0] === 3 && message[2] && /^https:\/\//i.test(message[1]));
  if (!images.length) throw new AppError(422, 'No downloadable images were found in this post.');
  const [, thumbnail, info] = images[0];
  return {
    title: info.title || info.description || info.caption || info.content,
    uploader: info.author?.name || info.author?.nick || info.user?.username || info.username || info.uploader,
    platform: info.category,
    thumbnail,
    width: info.width || info.image_width,
    height: info.height || info.image_height,
    itemCount: images.length
  };
}

async function downloadImages(tools, url, contentType, extension, {
  directory,
  signal,
  timeoutMs = 60 * 60_000,
  onProgress = null,
  extractorConfig = null
}) {
  const galleryDl = await requireTool(tools, 'gallery-dl');
  const ffmpeg = await requireTool(tools, 'ffmpeg');
  const galleryDlConfig = extractorConfig?.galleryDl || {};
  const deadline = Date.now() + timeoutMs;
  const remainingTime = () => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new AppError(504, 'Media processing timed out.');
    return remainingMs;
  };

  onProgress?.({ stage: 'downloading', detail: 'Fetching images...' });
  const { output } = await withCookiesFile(galleryDlConfig.cookiesFile, 'gallery-dl', signal, (cookiesFile) => {
    const args = [
      ...galleryArgs(contentType, { cookiesFile, proxy: galleryDlConfig.proxy }),
      '-o', 'output.mode=null', '--Print', 'after:{_path}', '--directory', directory, '--', url
    ];
    return runTool(galleryDl, args, {
      name: 'gallery-dl', signal, timeoutMs: remainingTime()
    });
  });
  const files = output ? output.split(/\r?\n/).slice(0, contentType === 'carousel' ? MAX_IMAGES : 1) : [];
  if (!files.length) throw new AppError(422, 'No downloadable images were found in this post.');

  const codecArgs = {
    jpg: ['-c:v', 'mjpeg', '-q:v', '2'],
    png: ['-c:v', 'png'],
    webp: ['-c:v', 'libwebp', '-quality', '90']
  }[extension];
  const realDirectory = await fs.realpath(directory);
  const resultDirectory = path.join(directory, 'converted');
  await fs.mkdir(resultDirectory);
  const outputs = [];
  for (const file of files) {
    const source = path.resolve(file);
    const sourceStat = await fs.lstat(source);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile() || (await fs.realpath(path.dirname(source))) !== realDirectory) {
      throw new AppError(422, 'The image extractor returned an invalid file.');
    }
    const current = outputs.length + 1;
    onProgress?.({
      stage: 'converting',
      current,
      total: files.length,
      percent: Math.round((current / files.length) * 100)
    });
    const name = `image-${String(current).padStart(2, '0')}.${extension}`;
    const target = path.join(resultDirectory, name);
    await runTool(ffmpeg, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file',
      '-i', source, '-map', '0:v:0', '-frames:v', '1', ...codecArgs, '-update', '1', target
    ], { name: 'ffmpeg', signal, timeoutMs: remainingTime() });
    const stats = await fs.stat(target);
    if (!stats.size) throw new AppError(422, 'Could not convert an image in this post.');
    outputs.push({ name, filePath: target, stats });
    await fs.unlink(source);
  }
  return outputs;
}

module.exports = {
  AppError, downloadImages, findExecutable, getExtractorConfig, getMediaTools,
  inspectImages, parseToolJson, requireTool, runYtDlp
};
