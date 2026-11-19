const { execFile, spawn } = require('node:child_process');
const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const ffmpegPath = require('ffmpeg-static');
const youtubeDlPackage = require('youtube-dl-exec');

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

function runTool(executable, args, { name, signal, timeoutMs, largeOutput = false }) {
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

    child.stdout.on('data', (chunk) => {
      stdoutSize += chunk.length;
      if (stdoutSize > (largeOutput ? 16 : 1) * 1024 * 1024) {
        stop(new AppError(422, 'Media extractor output was too large.'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrSize += chunk.length;
      if (stderrSize <= 2 * 1024 * 1024) stderr.push(chunk);
    });
    child.on('error', (error) => {
      const mapped = ['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code)
        ? new AppError(503, `The ${name} executable could not start. Check the media tool installation.`)
        : error;
      failure ||= mapped;
      settle(failure);
    });
    child.on('close', (exitCode) => {
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

async function runYtDlp(tools, url, flags, options) {
  const executable = await requireTool(tools, 'yt-dlp');
  const args = ['--ignore-config', '--no-cache-dir', ...youtubeDlPackage.args(flags), '--', url];
  return runTool(executable, args, { ...options, name: 'yt-dlp', largeOutput: flags.dumpSingleJson });
}

function galleryArgs(contentType) {
  return [
    '--config-ignore', '--no-input', '--cache-file', ':memory:', '--warning',
    '--http-timeout', '15', '--retries', '1',
    '--child-range', '1', '--child-filter', "category == 'pinterest' and subcategory == 'pinit'",
    '--post-range', '1',
    '--range', contentType === 'carousel' ? `1-${MAX_IMAGES}` : '1',
    '--filter', `extension.lower() in (${[...IMAGE_EXTENSIONS].map((ext) => `'${ext}'`).join(', ')})`
  ];
}

async function inspectImages(tools, url, contentType, signal) {
  const executable = await requireTool(tools, 'gallery-dl');
  const args = [...galleryArgs(contentType), '--resolve-json', '--', url];
  const { output } = await runTool(executable, args, {
    name: 'gallery-dl', signal, timeoutMs: 60_000, largeOutput: true
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

async function downloadImages(tools, url, contentType, extension, { directory, signal, timeoutMs = 60 * 60_000 }) {
  const galleryDl = await requireTool(tools, 'gallery-dl');
  const ffmpeg = await requireTool(tools, 'ffmpeg');
  const deadline = Date.now() + timeoutMs;
  const remainingTime = () => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new AppError(504, 'Media processing timed out.');
    return remainingMs;
  };

  const args = [
    ...galleryArgs(contentType),
    '-o', 'output.mode=null', '--Print', 'after:{_path}', '--directory', directory, '--', url
  ];
  const { output } = await runTool(galleryDl, args, {
    name: 'gallery-dl', signal, timeoutMs: remainingTime()
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
    const name = `image-${String(outputs.length + 1).padStart(2, '0')}.${extension}`;
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
  AppError, downloadImages, findExecutable, getMediaTools,
  inspectImages, parseToolJson, requireTool, runYtDlp
};
