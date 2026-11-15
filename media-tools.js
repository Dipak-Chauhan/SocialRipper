const { execFile, spawn } = require('node:child_process');
const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const ffmpegPath = require('ffmpeg-static');
const youtubeDlPackage = require('youtube-dl-exec');

const MAX_FILE_BYTES = 250 * 1024 * 1024;
const FILE_LIMIT_MESSAGE = 'This file is larger than the 250 MB download limit.';
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

async function checkFileBudget(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  let bytes = 0;
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    try {
      if (entry.isDirectory()) {
        bytes += MAX_FILE_BYTES - await checkFileBudget(filePath);
      } else if (entry.isFile()) {
        bytes += (await fs.stat(filePath)).size;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (bytes > MAX_FILE_BYTES) throw new AppError(413, FILE_LIMIT_MESSAGE);
  }
  return MAX_FILE_BYTES - bytes;
}

function runTool(executable, args, { name, signal, timeoutMs, directory, largeOutput = false }) {
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
    let budgetTimer;

    function stop(error) {
      if (finished || failure) return;
      failure = error;
      if (!child.pid) return;
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

    async function monitorBudget() {
      try {
        await checkFileBudget(directory);
        if (!finished && !failure) budgetTimer = setTimeout(monitorBudget, 100);
      } catch (error) {
        stop(error);
      }
    }

    const abort = () => stop(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => stop(new AppError(504, 'Media processing timed out.')), timeoutMs);
    if (directory) budgetTimer = setTimeout(monitorBudget, 100);

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
      if (['ENOENT', 'EACCES', 'ENOEXEC'].includes(error.code)) {
        failure ||= new AppError(503, `The ${name} executable could not start. Check the media tool installation.`);
      } else {
        failure ||= error;
      }
    });
    child.on('close', (exitCode) => {
      finished = true;
      clearTimeout(timeout);
      clearTimeout(budgetTimer);
      signal.removeEventListener('abort', abort);
      if (failure) return reject(failure);

      const diagnostic = Buffer.concat(stderr).toString('utf8').trim();
      if (exitCode !== 0) return reject(new Error(diagnostic || `${name} failed.`));
      resolve({ output: Buffer.concat(stdout).toString('utf8').trim(), diagnostic });
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

async function downloadImages(tools, url, contentType, extension, { directory, signal }) {
  const galleryDl = await requireTool(tools, 'gallery-dl');
  const ffmpeg = await requireTool(tools, 'ffmpeg');
  const args = [
    ...galleryArgs(contentType), '--filesize-max', String(MAX_FILE_BYTES),
    '-o', 'output.mode=null', '--Print', 'after:{_path}', '--directory', directory, '--', url
  ];
  const options = { directory, signal, timeoutMs: 10 * 60_000 };
  const { output, diagnostic } = await runTool(galleryDl, args, { ...options, name: 'gallery-dl' });
  if (/file size larger than allowed maximum/i.test(diagnostic)) throw new AppError(413, FILE_LIMIT_MESSAGE);
  const files = output ? output.split(/\r?\n/).slice(0, contentType === 'carousel' ? MAX_IMAGES : 1) : [];
  if (!files.length) throw new AppError(422, 'No downloadable images were found in this post.');
  await checkFileBudget(directory);

  const codec = { jpg: 'mjpeg', png: 'png', webp: 'libwebp' }[extension];
  const resultDirectory = path.join(directory, 'converted');
  await fs.mkdir(resultDirectory);
  const outputs = [];
  for (const file of files) {
    const source = path.resolve(file);
    if (path.dirname(source) !== directory || !(await fs.lstat(source)).isFile()) {
      throw new AppError(422, 'The image extractor returned an invalid file.');
    }
    const name = `image-${String(outputs.length + 1).padStart(2, '0')}.${extension}`;
    const target = path.join(resultDirectory, name);
    await runTool(ffmpeg, [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file',
      '-i', source, '-map', '0:v:0', '-frames:v', '1', '-c:v', codec, '-update', '1', target
    ], { ...options, name: 'ffmpeg' });
    await checkFileBudget(directory);
    const stats = await fs.stat(target);
    if (!stats.size) throw new AppError(422, 'Could not convert an image in this post.');
    outputs.push({ name, filePath: target, stats });
    await fs.unlink(source);
  }
  return outputs;
}

module.exports = {
  AppError, FILE_LIMIT_MESSAGE, checkFileBudget, downloadImages, findExecutable, getMediaTools,
  inspectImages, parseToolJson, requireTool, runYtDlp
};
