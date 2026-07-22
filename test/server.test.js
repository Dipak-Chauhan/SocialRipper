const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createServer,
  downloadOptions,
  imageDownloadOptions,
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

test('imageDownloadOptions converts posts and expands carousels', () => {
  const post = imageDownloadOptions('jpeg', 'post', 'image-%(autonumber)03d.%(ext)s');
  assert.equal(post.convertThumbnails, 'jpg');
  assert.equal(post.writeThumbnail, true);
  assert.equal(post.noPlaylist, true);

  const carousel = imageDownloadOptions('png', 'carousel', 'image-%(autonumber)03d.%(ext)s');
  assert.equal(carousel.convertThumbnails, 'png');
  assert.equal(carousel.yesPlaylist, true);
  assert.equal(carousel.playlistEnd, 20);
});

test('server serves the app and validates API input', async (context) => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const pageResponse = await fetch(origin);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get('content-type'), /text\/html/);
  assert.match(await pageResponse.text(), /Social Ripper/);

  const apiResponse = await fetch(`${origin}/api/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/video' })
  });
  assert.equal(apiResponse.status, 400);
  assert.match((await apiResponse.json()).error, /not supported/);
});
