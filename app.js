const form = document.querySelector('#download-form');
const urlInput = document.querySelector('#media-url');
const urlControl = document.querySelector('.url-control');
const urlError = document.querySelector('#url-error');
const pasteButton = document.querySelector('#paste-button');
const analyzeButton = document.querySelector('#analyze-button');
const contentTypeSelect = document.querySelector('#content-type');
const qualitySelect = document.querySelector('#quality');
const formatInputs = [...document.querySelectorAll('input[name="format"]')];
const formatOptions = [...document.querySelectorAll('.format-option')];
const platformTags = [...document.querySelectorAll('[data-platform]')];
const workingState = document.querySelector('#working-state');
const workingTitle = document.querySelector('#working-title');
const workingCopy = document.querySelector('#working-copy');
const resultCard = document.querySelector('#result-card');
const resultPreview = document.querySelector('.result-preview');
const resultImage = document.querySelector('#result-image');
const resultFallback = document.querySelector('#result-fallback');
const resultDuration = document.querySelector('#result-duration');
const resultSource = document.querySelector('#result-source');
const resultTitle = document.querySelector('#result-title');
const resultSummary = document.querySelector('#result-summary');
const downloadButton = document.querySelector('#download-button');
const downloadLabel = document.querySelector('#download-label');

const qualityChoices = {
  mp4: [
    ['best', 'Best available'],
    ['1080', '1080p'],
    ['720', '720p'],
    ['480', '480p']
  ],
  webm: [
    ['best', 'Best available'],
    ['1080', '1080p'],
    ['720', '720p'],
    ['480', '480p']
  ],
  mp3: [
    ['320', '320 kbps'],
    ['192', '192 kbps'],
    ['128', '128 kbps']
  ],
  jpg: [
    ['original', 'Best available']
  ],
  png: [
    ['original', 'Best available']
  ],
  webp: [
    ['original', 'Best available']
  ]
};

let currentMedia = null;
let analyzedUrl = '';
let analyzedContentType = '';
let activeRequest = null;

function selectedFormat() {
  return document.querySelector('input[name="format"]:checked').value;
}

function selectedContentType() {
  return contentTypeSelect.value;
}

function setError(message = '') {
  urlError.textContent = message;
  urlError.hidden = !message;
  urlControl.classList.toggle('has-error', Boolean(message));
  urlInput.setAttribute('aria-invalid', String(Boolean(message)));
}

function setWorking(active, title = '', copy = '') {
  workingState.hidden = !active;
  if (active) {
    workingTitle.textContent = title;
    workingCopy.textContent = copy;
  }
}

function setAnalyzeBusy(busy) {
  analyzeButton.disabled = busy;
  analyzeButton.querySelector('span').textContent = busy ? 'Scanning source...' : 'Inspect link';
}

function platformFromUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    if (host.includes('instagram')) return 'instagram';
    if (host.includes('tiktok')) return 'tiktok';
    if (host.includes('youtube') || host === 'youtu.be') return 'youtube';
    if (host === 'x.com' || host.endsWith('.x.com') || host.includes('twitter')) return 'x';
    if (host.includes('facebook') || host === 'fb.watch') return 'facebook';
  } catch {
    return '';
  }
  return '';
}

function updatePlatform() {
  const platform = platformFromUrl(urlInput.value.trim());
  platformTags.forEach((tag) => {
    tag.classList.toggle('is-active', tag.dataset.platform === platform);
  });
}

function updateQualityChoices() {
  const format = selectedFormat();
  const previousValue = qualitySelect.value;
  qualitySelect.replaceChildren();

  qualityChoices[format].forEach(([value, label]) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    qualitySelect.append(option);
  });

  if (qualityChoices[format].some(([value]) => value === previousValue)) {
    qualitySelect.value = previousValue;
  }
  updateResultSummary();
}

function updateContentType() {
  const formatKind = selectedContentType() === 'video' ? 'video' : 'image';
  formatOptions.forEach((option) => {
    option.hidden = option.dataset.formatKind !== formatKind;
  });

  const checkedOption = document.querySelector('input[name="format"]:checked')?.closest('.format-option');
  if (!checkedOption || checkedOption.hidden) {
    formatOptions.find((option) => !option.hidden).querySelector('input').checked = true;
  }
  updateQualityChoices();
}

function readableQuality() {
  return qualitySelect.options[qualitySelect.selectedIndex]?.textContent || '';
}

function updateResultSummary() {
  const contentType = selectedContentType();
  const format = selectedFormat().toUpperCase();
  downloadLabel.textContent = contentType === 'carousel' ? 'Download ZIP' : `Download ${format}`;
  if (currentMedia) {
    if (contentType === 'carousel') {
      const itemCount = currentMedia.itemCount ? ` / ${currentMedia.itemCount} ITEMS` : '';
      resultSummary.textContent = `${format} IMAGES${itemCount} / ZIP`;
    } else if (contentType === 'post') {
      resultSummary.textContent = `${format} IMAGE / ${readableQuality()}`;
    } else {
      resultSummary.textContent = `${format} / ${readableQuality()}`;
    }
  }
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds)));
  if (!Number.isFinite(total) || total === 0) return '';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
    : `${minutes}:${String(remaining).padStart(2, '0')}`;
}

function setPreviewAspect(width, height) {
  const previewWidth = Number(width);
  const previewHeight = Number(height);
  const hasDimensions = Number.isFinite(previewWidth)
    && Number.isFinite(previewHeight)
    && previewWidth > 0
    && previewHeight > 0;
  const ratio = hasDimensions ? previewWidth / previewHeight : 16 / 9;

  resultPreview.style.aspectRatio = hasDimensions
    ? `${Math.round(previewWidth)} / ${Math.round(previewHeight)}`
    : '16 / 9';
  resultPreview.style.maxWidth = `min(100%, ${Math.round(420 * ratio)}px)`;
  return hasDimensions;
}

function showResult(media) {
  currentMedia = media;
  resultTitle.textContent = media.title || 'Untitled media';
  const source = media.uploader ? `${media.platform} / ${media.uploader}` : media.platform;
  resultSource.textContent = media.itemCount > 1 ? `${source} / ${media.itemCount} ITEMS` : source;
  setPreviewAspect(media.width, media.height);

  const duration = formatDuration(media.duration);
  resultDuration.textContent = duration;
  resultDuration.hidden = !duration;

  if (media.thumbnail) {
    resultImage.src = media.thumbnail;
    resultImage.alt = `${media.title || 'Media'} preview`;
    resultImage.hidden = false;
    resultFallback.hidden = true;
  } else {
    resultImage.removeAttribute('src');
    resultImage.alt = '';
    resultImage.hidden = true;
    resultFallback.hidden = false;
  }

  updateResultSummary();
  resultCard.hidden = false;
}

async function readError(response) {
  try {
    const payload = await response.json();
    return payload.error || 'Something went wrong. Please try again.';
  } catch {
    return 'Something went wrong. Please try again.';
  }
}

async function analyzeMedia(event) {
  event.preventDefault();
  const url = urlInput.value.trim();
  const contentType = selectedContentType();
  setError();

  if (!url) {
    setError('Paste a public media link to continue.');
    urlInput.focus();
    return;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('Invalid protocol');
  } catch {
    setError('Enter a complete HTTPS link from a supported site.');
    urlInput.focus();
    return;
  }

  activeRequest?.abort();
  activeRequest = new AbortController();
  resultCard.hidden = true;
  setAnalyzeBusy(true);
  setWorking(true, 'Inspecting source...', 'This usually takes a few seconds.');

  try {
    const response = await fetch('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, contentType }),
      signal: activeRequest.signal
    });

    if (!response.ok) throw new Error(await readError(response));
    const media = await response.json();
    analyzedUrl = url;
    analyzedContentType = contentType;
    showResult(media);
  } catch (error) {
    if (error.name !== 'AbortError') {
      setError(error.message || 'Could not read this link.');
    }
  } finally {
    setAnalyzeBusy(false);
    setWorking(false);
    activeRequest = null;
  }
}

function filenameFromResponse(response, fallback) {
  const disposition = response.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="([^"]+)"/i);
  return match?.[1] || fallback;
}

async function downloadMedia() {
  const contentType = selectedContentType();
  if (
    !currentMedia
    || analyzedUrl !== urlInput.value.trim()
    || analyzedContentType !== contentType
  ) return;

  const format = selectedFormat();
  const quality = qualitySelect.value;
  downloadButton.disabled = true;
  setError();
  const outputLabel = contentType === 'carousel' ? 'ZIP' : format.toUpperCase();
  setWorking(true, `Preparing ${outputLabel}...`, 'The time needed depends on the file size.');

  try {
    const response = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: analyzedUrl,
        format,
        quality,
        contentType,
        title: currentMedia.title
      })
    });

    if (!response.ok) throw new Error(await readError(response));
    workingTitle.textContent = 'Saving your file...';
    workingCopy.textContent = 'Keep this tab open until the download starts.';

    const file = await response.blob();
    const objectUrl = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = objectUrl;
    const extension = contentType === 'carousel' ? 'zip' : format;
    link.download = filenameFromResponse(response, `social-ripper.${extension}`);
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (error) {
    setError(error.message || 'Could not download this media.');
  } finally {
    downloadButton.disabled = false;
    setWorking(false);
  }
}

async function pasteUrl() {
  setError();
  try {
    const text = await navigator.clipboard.readText();
    if (!text) throw new Error('Clipboard is empty');
    urlInput.value = text.trim();
    urlInput.dispatchEvent(new Event('input'));
    urlInput.focus();
  } catch {
    urlInput.focus();
    setError('Clipboard access was blocked. Paste the link into the field.');
  }
}

form.addEventListener('submit', analyzeMedia);
pasteButton.addEventListener('click', pasteUrl);
downloadButton.addEventListener('click', downloadMedia);
qualitySelect.addEventListener('change', updateResultSummary);
formatInputs.forEach((input) => input.addEventListener('change', updateQualityChoices));
contentTypeSelect.addEventListener('change', () => {
  updateContentType();
  resultCard.hidden = true;
  currentMedia = null;
  analyzedContentType = '';
});
urlInput.addEventListener('input', () => {
  setError();
  updatePlatform();
  if (urlInput.value.trim() !== analyzedUrl) {
    resultCard.hidden = true;
    currentMedia = null;
    analyzedContentType = '';
  }
});
resultImage.addEventListener('error', () => {
  resultImage.hidden = true;
  resultFallback.hidden = false;
});
resultImage.addEventListener('load', () => {
  if (!currentMedia?.width || !currentMedia?.height) {
    setPreviewAspect(resultImage.naturalWidth, resultImage.naturalHeight);
  }
});
updateContentType();
