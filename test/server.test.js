const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('node:test');
const {
  createServer,
  downloadOptions,
  validateMediaUrl
} = require('../server');

test('validateMediaUrl accepts supported HTTPS links', () => {
  assert.equal(
    validateMediaUrl('https://www.instagram.com/reel/example/#watch'),
    'https://www.instagram.com/reel/example/'
  );
  assert.equal(validateMediaUrl('https://youtu.be/example'), 'https://youtu.be/example');
});

test('validateMediaUrl rejects unsafe or unsupported links', () => {
  assert.throws(() => validateMediaUrl('http://youtube.com/watch?v=test'), /HTTPS/);
  assert.throws(() => validateMediaUrl('https://example.com/video'), /not supported/);
  assert.throws(() => validateMediaUrl('not a url'), /complete link/);
  assert.throws(() => validateMediaUrl('https://user:secret@youtube.com/watch?v=test'), /credentials/);
  assert.throws(() => validateMediaUrl('https://youtube.com:8443/watch?v=test'), /custom port/);
});

test('downloadOptions creates bounded video and audio configurations', () => {
  const video = downloadOptions('mp4', '720', 'media.%(ext)s');
  assert.match(video.format, /height<=720/);
  assert.equal(video.mergeOutputFormat, 'mp4');
  assert.equal(video.maxFilesize, '250M');

  const audio = downloadOptions('mp3', '192', 'media.%(ext)s');
  assert.equal(audio.audioFormat, 'mp3');
  assert.equal(audio.audioQuality, '192K');
  assert.equal(audio.extractAudio, true);
});

async function startServer(context, options) {
  const server = createServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

function post(origin, route, body, options = {}) {
  return fetch(`${origin}/api/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...options
  });
}

test('server serves the app and validates API input', async (context) => {
  const origin = await startServer(context);
  const pageResponse = await fetch(origin);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get('content-type'), /text\/html/);
  assert.match(await pageResponse.text(), /Social Ripper/);

  const apiResponse = await post(origin, 'info', { url: 'https://example.com/video' });
  assert.equal(apiResponse.status, 400);
  assert.match((await apiResponse.json()).error, /not supported/);
});

test('media routes reject cross-origin requests and non-object bodies', async (context) => {
  const origin = await startServer(context);
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
  const origin = await startServer(context, { tools });
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

async function startFixtureServer(context) {
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
    const descriptor = fs.openSync(filename + '.part', 'w');
    fs.ftruncateSync(descriptor, 251 * 1024 * 1024);
    fs.closeSync(descriptor);
    put('large', filename);
    setInterval(() => {}, 1000);
  } else if (url.includes('/stream')) {
    const descriptor = fs.openSync(filename, 'w');
    fs.ftruncateSync(descriptor, 32 * 1024 * 1024);
    fs.closeSync(descriptor);
    put('stream', filename);
  } else {
    fs.writeFileSync(filename, 'fixture video');
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
    ffmpeg: `fs.copyFileSync(next('-i'), args.at(-1));`
  };
  const tools = {};
  for (const [name, script] of Object.entries(scripts)) {
    const file = path.join(directory, name);
    await fs.writeFile(file, fixtureSource(script), { mode: 0o700 });
    tools[name] = [file];
  }
  return { origin: await startServer(context, { tools }), directory };
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

test('download stops writing at the monitored size limit and removes partial files', { skip: process.platform === 'win32' }, async (context) => {
  const { origin, directory } = await startFixtureServer(context);
  const response = await post(origin, 'download', { url: 'https://youtu.be/large', format: 'mp4', quality: 'best' }, {
    signal: AbortSignal.timeout(5000)
  });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /250 MB/);
  const output = await readEventually(path.join(directory, 'large'));
  await assert.rejects(fs.stat(path.dirname(output)), { code: 'ENOENT' });
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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const removed = await fs.stat(path.dirname(output)).then(() => false, (error) => error.code === 'ENOENT');
    if (removed) return;
    await delay(20);
  }
  assert.fail('The disconnected file stream left its temporary directory behind');
});

test('image posts and carousel ZIPs use image extraction and preserve item order', { skip: process.platform === 'win32' }, async (context) => {
  const { origin } = await startFixtureServer(context);
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

  const carousel = await post(origin, 'download', { url, contentType: 'carousel', format: 'png' });
  assert.equal(carousel.status, 200);
  assert.equal(carousel.headers.get('content-type'), 'application/zip');
  const archive = Buffer.from(await carousel.arrayBuffer());
  assert.equal(archive.readUInt32LE(0), 0x04034b50);
  assert.ok(archive.includes(Buffer.from('01.png')));
  assert.ok(archive.indexOf('02.png') > archive.indexOf('01.png'));

  const videoOnly = await post(origin, 'info', { url: 'https://youtu.be/video-only', contentType: 'post' });
  assert.equal(videoOnly.status, 422);
  assert.match((await videoOnly.json()).error, /No downloadable images/);
});
