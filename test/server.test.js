const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const {
  contentDisposition,
  createServer,
  downloadOptions,
  parsePort,
  validateMediaUrl
} = require('../server');

test('validateMediaUrl accepts supported HTTPS links', () => {
  assert.equal(
    validateMediaUrl('https://www.instagram.com/reel/example/#watch'),
    'https://www.instagram.com/reel/example/'
  );
  assert.equal(validateMediaUrl('https://youtu.be/example'), 'https://youtu.be/example');
  assert.equal(validateMediaUrl('https://www.threads.com/@user/post/123'), 'https://www.threads.com/@user/post/123');
  assert.equal(validateMediaUrl('https://redd.it/example'), 'https://redd.it/example');
  assert.equal(validateMediaUrl('https://pin.it/example'), 'https://pin.it/example');
});

test('validateMediaUrl rejects unsafe or unsupported links', () => {
  assert.throws(() => validateMediaUrl('http://youtube.com/watch?v=test'), /HTTPS/);
  assert.throws(() => validateMediaUrl('https://example.com/video'), /not supported/);
  assert.throws(() => validateMediaUrl('not a url'), /complete link/);
  assert.throws(() => validateMediaUrl('https://user:secret@youtube.com/watch?v=test'), /credentials/);
  assert.throws(() => validateMediaUrl('https://youtube.com:8443/watch?v=test'), /custom port/);
});

test('downloadOptions creates unbounded video and audio configurations', () => {
  const video = downloadOptions('mp4', '720', 'media.%(ext)s');
  assert.match(video.format, /height<=720/);
  assert.equal(video.mergeOutputFormat, 'mp4/mkv');
  assert.equal(video.recodeVideo, 'mp4');
  assert.equal(video.maxFilesize, undefined);

  const webm = downloadOptions('webm', '1080', 'media.%(ext)s');
  assert.match(webm.format, /height<=1080/);
  assert.equal(webm.mergeOutputFormat, 'webm/mkv');
  assert.equal(webm.recodeVideo, 'webm');
  assert.equal(webm.maxFilesize, undefined);

  const audio = downloadOptions('mp3', '192', 'media.%(ext)s');
  assert.equal(audio.audioFormat, 'mp3');
  assert.equal(audio.audioQuality, '192K');
  assert.equal(audio.extractAudio, true);
  assert.equal(audio.maxFilesize, undefined);
});

test('parsePort validates ports strictly', () => {
  assert.equal(parsePort(undefined, 3000), 3000);
  assert.equal(parsePort('', 3000), 3000);
  assert.equal(parsePort('8080', 3000), 8080);
  assert.equal(parsePort('0', 3000), 0);
  assert.equal(parsePort('65535', 3000), 65535);
  for (const invalid of ['abc', '-1', '70000', '3000abc', '30.5']) {
    assert.throws(() => parsePort(invalid, 3000), RangeError);
  }
});

test('contentDisposition preserves Unicode filenames via RFC 5987 with ASCII fallback', () => {
  const ascii = contentDisposition('Simple Video', 'mp4');
  assert.equal(ascii.filename, 'Simple Video.mp4');
  assert.equal(ascii.header, 'attachment; filename="Simple Video.mp4"');

  const unicode = contentDisposition('Café 動画', 'mp4');
  assert.equal(unicode.filename, 'Café 動画.mp4');
  assert.equal(
    unicode.header,
    "attachment; filename=\"Cafe.mp4\"; filename*=UTF-8''Caf%C3%A9%20%E5%8B%95%E7%94%BB.mp4"
  );

  const nonLatinOnly = contentDisposition('日本語タイトル', 'zip', '-png-carousel');
  assert.equal(nonLatinOnly.filename, '日本語タイトル-png-carousel.zip');
  assert.match(nonLatinOnly.header, /^attachment; filename="social-media-png-carousel\.zip"; filename\*=UTF-8''/);
});

async function startServer(context, options) {
  const server = createServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => server.shutdown());
  return { origin: `http://127.0.0.1:${server.address().port}`, server };
}

function post(origin, route, body, options = {}) {
  return fetch(`${origin}/api/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...options
  });
}

function rawHttpRequest(origin, method, pathname, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(origin);
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: pathname,
      method,
      headers
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
    });
    request.once('error', reject);
    if (body !== null) request.write(body);
    request.end();
  });
}

test('server serves the app, PWA assets, share target, and validates API input', async (context) => {
  const { origin } = await startServer(context);
  const pageResponse = await fetch(origin);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get('content-type'), /text\/html/);
  const csp = pageResponse.headers.get('content-security-policy');
  assert.match(csp, /manifest-src 'self'/);
  assert.match(csp, /worker-src 'self'/);
  const html = await pageResponse.text();
  assert.match(html, /Social Ripper/);
  assert.match(html, /rel="manifest"/);
  assert.match(html, /href="https:\/\/github\.com\/Dipak-Chauhan\/social-ripper"[^>]*rel="noopener noreferrer"/);
  assert.match(html, /href="https:\/\/ko-fi\.com\/dipakchauhan"[^>]*rel="noopener noreferrer"/);
  assert.match(html, /href="https:\/\/buymeacoffee\.com\/dipakchauhan"[^>]*rel="noopener noreferrer"/);

  const shareResponse = await fetch(`${origin}/share-target?text=${encodeURIComponent('Watch https://www.instagram.com/reel/example/')}`);
  assert.equal(shareResponse.status, 200);
  assert.match(shareResponse.headers.get('content-type'), /text\/html/);
  assert.equal(shareResponse.headers.get('cache-control'), 'no-cache');
  assert.match(await shareResponse.text(), /id="share-banner"/);

  const manifestResponse = await fetch(`${origin}/manifest.webmanifest`);
  assert.equal(manifestResponse.status, 200);
  assert.match(manifestResponse.headers.get('content-type'), /application\/manifest\+json/);
  assert.equal(manifestResponse.headers.get('cache-control'), 'no-cache');
  const manifest = await manifestResponse.json();
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.share_target?.action, '/share-target');
  assert.deepEqual(manifest.share_target?.params, { title: 'title', text: 'text', url: 'url' });
  assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192' && icon.purpose === 'any'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'any'));
  assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'maskable'));

  const swResponse = await fetch(`${origin}/sw.js`);
  assert.equal(swResponse.status, 200);
  assert.match(swResponse.headers.get('content-type'), /text\/javascript/);
  assert.equal(swResponse.headers.get('cache-control'), 'no-cache');
  assert.equal(swResponse.headers.get('service-worker-allowed'), '/');
  assert.match(await swResponse.text(), /startsWith\('\/api\/'\)/);

  const expectedIcons = [
    ['/icons/icon-192.png', 192, 192],
    ['/icons/icon-512.png', 512, 512],
    ['/icons/icon-maskable-512.png', 512, 512],
    ['/icons/apple-touch-icon.png', 180, 180]
  ];
  for (const [iconPath, width, height] of expectedIcons) {
    const iconResponse = await fetch(`${origin}${iconPath}`);
    assert.equal(iconResponse.status, 200, iconPath);
    assert.equal(iconResponse.headers.get('content-type'), 'image/png', iconPath);
    const png = Buffer.from(await iconResponse.arrayBuffer());
    assert.deepEqual(png.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    assert.equal(png.readUInt32BE(16), width, `${iconPath} width`);
    assert.equal(png.readUInt32BE(20), height, `${iconPath} height`);
  }

  const apiResponse = await post(origin, 'info', { url: 'https://example.com/video' });
  assert.equal(apiResponse.status, 400);
  assert.match((await apiResponse.json()).error, /not supported/);
});

test('media routes reject cross-origin requests and non-object bodies', async (context) => {
  const { origin } = await startServer(context);
  const body = { url: 'https://youtu.be/example' };
  const rejected = [
    [{ 'Content-Type': 'text/plain' }, 415],
    [{ 'Content-Type': 'text/plain', Origin: 'https://example.org' }, 403],
    [{ 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-site' }, 403],
    [{ 'Content-Type': 'application/json', Host: 'rebound.example.org', Origin: 'http://rebound.example.org' }, 403]
  ];
  for (const [headers, status] of rejected) {
    const response = await post(origin, 'info', body, { headers });
    assert.equal(response.status, status);
    await response.json();
  }
  for (const invalid of [null, false, [], 'text']) {
    const response = await post(origin, 'download', invalid);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /JSON object/);
  }
  const large = await post(origin, 'info', { url: 'x'.repeat(17 * 1024) });
  assert.equal(large.status, 413);
  await large.json();
});

test('health and inspection identify missing executables', async (context) => {
  const tools = { 'yt-dlp': [], ffmpeg: [], 'gallery-dl': [] };
  const { origin } = await startServer(context, { tools });
  const health = await fetch(`${origin}/api/health`);
  assert.equal(health.status, 503);
  assert.deepEqual(await health.json(), {
    status: 'unavailable', tools: { 'yt-dlp': false, ffmpeg: false, 'gallery-dl': false }
  });
  for (const [contentType, executable] of [['video', 'yt-dlp'], ['post', 'gallery-dl']]) {
    const response = await post(origin, 'info', { url: 'https://youtu.be/example', contentType });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, new RegExp(executable));
  }
});

test('unstartable tool executable fails fast with 503', { skip: process.platform === 'win32' }, async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'social-ripper-badtool-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const brokenTool = path.join(directory, 'yt-dlp');
  await fs.writeFile(brokenTool, '#!/nonexistent-interpreter-xyz\n', { mode: 0o700 });
  const tools = { 'yt-dlp': [brokenTool], ffmpeg: [], 'gallery-dl': [] };
  const { origin } = await startServer(context, { tools });

  const response = await post(origin, 'info', { url: 'https://youtu.be/example' }, {
    signal: AbortSignal.timeout(3000)
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /could not start/);
});

async function startFixtureServer(context, serverOptions = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'social-ripper-test-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fixtureSource = (script) => `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const url = args.at(-1);
const next = (flag) => args[args.indexOf(flag) + 1];
const put = (name, value) => fs.writeFileSync(path.join(${JSON.stringify(directory)}, name), String(value));
${script}
`;
  const scripts = {
    'yt-dlp': `
if (args.includes('--dump-single-json')) {
  if (url.includes('/slow')) {
    put(url.split('/').pop(), process.pid);
    setInterval(() => {}, 1000);
  } else {
    console.log(JSON.stringify({ title: 'Fixture video', extractor_key: 'Fixture' }));
  }
} else {
  const filename = next('--output').replace('%(ext)s', 'mp4');
  if (url.includes('/large')) {
    const descriptor = fs.openSync(filename, 'w');
    fs.ftruncateSync(descriptor, 260 * 1024 * 1024);
    fs.closeSync(descriptor);
    put('large', filename);
  } else if (url.includes('/stream')) {
    const descriptor = fs.openSync(filename, 'w');
    fs.ftruncateSync(descriptor, 32 * 1024 * 1024);
    fs.closeSync(descriptor);
    put('stream', filename);
  } else {
    fs.writeFileSync(filename, 'fixture video');
    put('last-video', filename);
  }
}`,
    'gallery-dl': `
if (url.includes('/video-only')) {
  console.log('[]');
} else if (args.includes('--resolve-json')) {
  console.log(JSON.stringify([
    [2, {category: 'instagram'}],
    [3, 'https://images.example.org/original-1.jpg', {category: 'instagram', width: 1080, height: 720}],
    [3, 'https://images.example.org/original-2.jpg', {category: 'instagram'}]
  ].slice(0, next('--range') === '1' ? 2 : 3)));
} else {
  const images = next('--range') === '1' ? ['first'] : ['first', 'second'];
  for (const image of images) {
    const filename = path.join(next('--directory'), image + '.jpg');
    fs.writeFileSync(filename, image);
    console.log(filename);
  }
}`,
    ffmpeg: `
fs.appendFileSync(path.join(${JSON.stringify(directory)}, 'ffmpeg-args.log'), JSON.stringify(args) + '\\n');
fs.copyFileSync(next('-i'), args.at(-1));`
  };
  const tools = {};
  for (const [name, script] of Object.entries(scripts)) {
    const file = path.join(directory, name);
    await fs.writeFile(file, fixtureSource(script), { mode: 0o700 });
    tools[name] = [file];
  }
  const { origin, server } = await startServer(context, { tools, ...serverOptions });
  return { origin, server, directory };
}

async function readEventually(file) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await delay(20);
    }
  }
  throw new Error(`Fixture did not write ${file}`);
}

async function waitForRemoved(targetPath) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const removed = await fs.stat(targetPath).then(() => false, (error) => error.code === 'ENOENT');
    if (removed) return;
    await delay(20);
  }
  await assert.rejects(fs.stat(targetPath), { code: 'ENOENT' });
}

test('inspections share download slots and disconnects stop extraction', { skip: process.platform === 'win32' }, async (context) => {
  const { origin, directory } = await startFixtureServer(context);
  const controllers = [new AbortController(), new AbortController()];
  const pending = controllers.map(({ signal }, index) =>
    post(origin, 'info', { url: `https://youtu.be/slow-${index}` }, { signal }).catch((error) => error));
  context.after(() => controllers.forEach((controller) => controller.abort()));
  const pid = Number(await readEventually(path.join(directory, 'slow-0')));
  await readEventually(path.join(directory, 'slow-1'));
  const busy = await post(origin, 'download', { url: 'https://youtu.be/example', format: 'mp4', quality: 'best' });
  assert.equal(busy.status, 429);
  await busy.json();

  controllers[0].abort();
  assert.equal((await pending[0]).name, 'AbortError');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await post(origin, 'info', { url: 'https://youtu.be/example' });
    if (response.status === 200) {
      assert.equal((await response.json()).title, 'Fixture video');
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
      return;
    }
    assert.equal(response.status, 429);
    await response.json();
    await delay(20);
  }
  assert.fail('The disconnected job did not release its slot');
});

test('downloads above 250 MiB stream cleanly and remove temporary files', { skip: process.platform === 'win32' }, async (context) => {
  const { origin, directory } = await startFixtureServer(context);
  const expectedBytes = 260 * 1024 * 1024;
  const response = await post(origin, 'download', { url: 'https://youtu.be/large', format: 'mp4', quality: 'best' }, {
    signal: AbortSignal.timeout(30_000)
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(expectedBytes));

  let totalBytes = 0;
  for await (const chunk of response.body) {
    totalBytes += chunk.length;
  }
  assert.equal(totalBytes, expectedBytes);

  const output = await readEventually(path.join(directory, 'large'));
  await waitForRemoved(path.dirname(output));
});

test('single-file downloads hold their slot until streaming ends', { skip: process.platform === 'win32' }, async (context) => {
  const { origin, directory } = await startFixtureServer(context);
  const controller = new AbortController();
  context.after(() => controller.abort());
  const inspection = post(origin, 'info', { url: 'https://youtu.be/slow-inspection' }, { signal: controller.signal })
    .catch((error) => error);
  await readEventually(path.join(directory, 'slow-inspection'));

  const data = JSON.stringify({ url: 'https://youtu.be/stream', format: 'mp4', quality: 'best' });
  let request;
  const transfer = await new Promise((resolve, reject) => {
    request = http.request(`${origin}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, resolve);
    request.once('error', reject);
    request.end(data);
  });
  context.after(() => request.destroy());
  assert.equal(transfer.statusCode, 200);
  const busy = await post(origin, 'info', { url: 'https://youtu.be/example' });
  assert.equal(busy.status, 429);
  await busy.json();

  request.destroy();
  controller.abort();
  assert.equal((await inspection).name, 'AbortError');
  const output = await readEventually(path.join(directory, 'stream'));
  await waitForRemoved(path.dirname(output));
});

test('two-phase downloads support Unicode filenames, store-mode ZIPs, slot reservation, and replay protection', { skip: process.platform === 'win32' }, async (context) => {
  const { origin, directory } = await startFixtureServer(context);

  const slowController = new AbortController();
  context.after(() => slowController.abort());
  const slowInspection = post(origin, 'info', { url: 'https://youtu.be/slow-two-phase' }, {
    signal: slowController.signal
  }).catch((error) => error);
  await readEventually(path.join(directory, 'slow-two-phase'));

  const prep = await post(origin, 'downloads', {
    url: 'https://youtu.be/example',
    format: 'mp4',
    quality: 'best',
    title: 'Café 動画'
  });
  assert.equal(prep.status, 200);
  const prepared = await prep.json();
  assert.match(prepared.downloadUrl, /^\/api\/downloads\/[A-Za-z0-9_-]+$/);
  assert.equal(prepared.filename, 'Café 動画.mp4');
  assert.equal(prepared.size, Buffer.byteLength('fixture video'));

  // Slot stays reserved while waiting for the browser to fetch downloadUrl.
  const busy = await post(origin, 'info', { url: 'https://youtu.be/example' });
  assert.equal(busy.status, 429);
  await busy.json();

  slowController.abort();
  assert.equal((await slowInspection).name, 'AbortError');

  const downloadResponse = await fetch(`${origin}${prepared.downloadUrl}`);
  assert.equal(downloadResponse.status, 200);
  assert.equal(
    downloadResponse.headers.get('content-disposition'),
    "attachment; filename=\"Cafe.mp4\"; filename*=UTF-8''Caf%C3%A9%20%E5%8B%95%E7%94%BB.mp4"
  );
  assert.equal(await downloadResponse.text(), 'fixture video');

  const tempFile = await readEventually(path.join(directory, 'last-video'));
  await waitForRemoved(path.dirname(tempFile));

  const replay = await fetch(`${origin}${prepared.downloadUrl}`);
  assert.equal(replay.status, 404);
  await replay.json();

  // Carousel via two-phase endpoint uses store mode (compression method 0).
  const zipPrep = await post(origin, 'downloads', {
    url: 'https://www.instagram.com/p/example/',
    contentType: 'carousel',
    format: 'png',
    title: 'Carousel Set'
  });
  assert.equal(zipPrep.status, 200);
  const zipInfo = await zipPrep.json();
  assert.equal(zipInfo.filename, 'Carousel Set-png-carousel.zip');
  assert.equal(zipInfo.size, null);

  const zipResponse = await fetch(`${origin}${zipInfo.downloadUrl}`);
  assert.equal(zipResponse.status, 200);
  assert.equal(zipResponse.headers.get('content-type'), 'application/zip');
  const archive = Buffer.from(await zipResponse.arrayBuffer());
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  assert.equal(archive.readUInt16LE(8), 0);
  assert.ok(archive.includes(Buffer.from('01.png')));
  assert.ok(archive.indexOf('02.png') > archive.indexOf('01.png'));
});

test('unclaimed prepared download tokens expire and release temporary files and slots', { skip: process.platform === 'win32' }, async (context) => {
  const { origin, directory } = await startFixtureServer(context, { pendingDownloadTtlMs: 100 });
  const prep = await post(origin, 'downloads', {
    url: 'https://youtu.be/stream',
    format: 'mp4',
    quality: 'best'
  });
  assert.equal(prep.status, 200);
  const { downloadUrl } = await prep.json();
  const output = await readEventually(path.join(directory, 'stream'));
  await waitForRemoved(path.dirname(output));

  const expired = await fetch(`${origin}${downloadUrl}`);
  assert.equal(expired.status, 404);
  await expired.json();
});

test('image posts and carousel ZIPs use image extraction, quality flags, and preserve item order', { skip: process.platform === 'win32' }, async (context) => {
  const { origin, directory } = await startFixtureServer(context);
  const url = 'https://www.instagram.com/p/example/';
  const metadata = await post(origin, 'info', { url, contentType: 'carousel' });
  assert.equal(metadata.status, 200);
  const info = await metadata.json();
  assert.equal(info.thumbnail, 'https://images.example.org/original-1.jpg');
  assert.equal(info.itemCount, 2);

  const single = await post(origin, 'download', { url, contentType: 'post', format: 'jpeg' });
  assert.equal(single.status, 200);
  assert.equal(single.headers.get('content-type'), 'image/jpeg');
  assert.equal(await single.text(), 'first');

  const webp = await post(origin, 'download', { url, contentType: 'post', format: 'webp' });
  assert.equal(webp.status, 200);
  assert.equal(webp.headers.get('content-type'), 'image/webp');
  assert.equal(await webp.text(), 'first');

  const ffmpegCalls = (await fs.readFile(path.join(directory, 'ffmpeg-args.log'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(ffmpegCalls.some((call) => call.includes('mjpeg') && call.includes('-q:v') && call.includes('2')));
  assert.ok(ffmpegCalls.some((call) => call.includes('libwebp') && call.includes('-quality') && call.includes('90')));

  const carousel = await post(origin, 'download', { url, contentType: 'carousel', format: 'png' });
  assert.equal(carousel.status, 200);
  assert.equal(carousel.headers.get('content-type'), 'application/zip');
  const archive = Buffer.from(await carousel.arrayBuffer());
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  assert.equal(archive.readUInt16LE(8), 0);
  assert.ok(archive.includes(Buffer.from('01.png')));
  assert.ok(archive.indexOf('02.png') > archive.indexOf('01.png'));

  const videoOnly = await post(origin, 'info', { url: 'https://youtu.be/video-only', contentType: 'post' });
  assert.equal(videoOnly.status, 422);
  assert.match((await videoOnly.json()).error, /No downloadable images/);
});

test('requireSameOrigin allows LAN IP hosts on wildcard bind and configured allowedHosts', { skip: process.platform === 'win32' }, async (context) => {
  const { origin } = await startFixtureServer(context, {
    host: '0.0.0.0',
    allowedHosts: new Set(['media.example.com'])
  });
  const payload = JSON.stringify({ url: 'https://youtu.be/example' });

  const lan = await rawHttpRequest(origin, 'POST', '/api/info', {
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      Host: '192.168.1.25:3000',
      Origin: 'http://192.168.1.25:3000'
    },
    body: payload
  });
  assert.equal(lan.status, 200);

  const rebound = await rawHttpRequest(origin, 'POST', '/api/info', {
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      Host: 'rebound.example.org',
      Origin: 'http://rebound.example.org'
    },
    body: payload
  });
  assert.equal(rebound.status, 403);

  const allowedHttps = await rawHttpRequest(origin, 'POST', '/api/info', {
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      Host: 'media.example.com',
      Origin: 'https://media.example.com'
    },
    body: payload
  });
  assert.equal(allowedHttps.status, 200);

  const evilOrigin = await rawHttpRequest(origin, 'POST', '/api/info', {
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      Host: 'media.example.com',
      Origin: 'https://evil.example.com'
    },
    body: payload
  });
  assert.equal(evilOrigin.status, 403);
});

test('server.shutdown kills active jobs and cleans up pending temporary directories', { skip: process.platform === 'win32' }, async (context) => {
  const { origin, server, directory } = await startFixtureServer(context);
  const inspection = post(origin, 'info', { url: 'https://youtu.be/slow-shutdown' }).catch((error) => error);
  const pid = Number(await readEventually(path.join(directory, 'slow-shutdown')));

  const prep = await post(origin, 'downloads', {
    url: 'https://youtu.be/stream',
    format: 'mp4',
    quality: 'best'
  });
  assert.equal(prep.status, 200);
  const streamOutput = await readEventually(path.join(directory, 'stream'));

  await server.shutdown();

  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await assert.rejects(fs.stat(path.dirname(streamOutput)), { code: 'ENOENT' });
  const outcome = await inspection;
  assert.ok(outcome instanceof Error || outcome?.status === 503);
});
