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
const cancelButton = document.querySelector('#cancel-button');
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
const engineStatus = document.querySelector('#engine-status');
const installNavButton = document.querySelector('#install-nav-button');
const installPopup = document.querySelector('#install-popup');
const installPopupTitle = document.querySelector('#install-popup-title');
const installPopupCopy = document.querySelector('#install-popup-copy');
const installIosSteps = document.querySelector('#install-ios-steps');
const installActionButton = document.querySelector('#install-action-button');
const installDismissButton = document.querySelector('#install-dismiss-button');
const installCloseButton = document.querySelector('#install-close-button');
const shareBanner = document.querySelector('#share-banner');
const shareBannerText = document.querySelector('#share-banner-text');

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
let activeDownload = null;
let hasGalleryDl = false;
let deferredInstallPrompt = null;

const INSTALL_DISMISS_KEY = 'social-ripper-install-dismissed-at';
const INSTALL_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

const PLATFORM_DOMAINS = [
  ['instagram', ['instagram.com']],
  ['tiktok', ['tiktok.com']],
  ['youtube', ['youtube.com', 'youtu.be']],
  ['x', ['x.com', 'twitter.com']],
  ['facebook', ['facebook.com', 'fb.watch']],
  ['threads', ['threads.net', 'threads.com']],
  ['vimeo', ['vimeo.com']],
  ['reddit', ['reddit.com', 'redd.it']],
  ['pinterest', ['pinterest.com', 'pin.it']]
];

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

function clearInspection() {
  if (activeRequest) {
    activeRequest.abort();
    activeRequest = null;
    setAnalyzeBusy(false);
    setWorking(false);
  }
  if (activeDownload) {
    activeDownload.abort();
    activeDownload = null;
    downloadButton.disabled = false;
    analyzeButton.disabled = false;
    setWorking(false);
  }
  resultCard.hidden = true;
  currentMedia = null;
  analyzedUrl = '';
  analyzedContentType = '';
}

function setImageOptionsEnabled(enabled) {
  const postOption = contentTypeSelect.querySelector('option[value="post"]');
  const carouselOption = contentTypeSelect.querySelector('option[value="carousel"]');
  if (postOption) {
    postOption.disabled = !enabled;
    postOption.textContent = enabled ? 'Image post' : 'Image post (needs gallery-dl)';
  }
  if (carouselOption) {
    carouselOption.disabled = !enabled;
    carouselOption.textContent = enabled ? 'Carousel (ZIP)' : 'Carousel (ZIP, needs gallery-dl)';
  }
  if (!enabled && contentTypeSelect.value !== 'video') {
    contentTypeSelect.value = 'video';
    clearInspection();
    updateContentType();
  }
}

async function updateEngineStatus() {
  let label = 'ENGINE UNAVAILABLE';
  let statusClass = 'is-offline';
  let online = false;
  hasGalleryDl = false;
  try {
    const response = await fetch('/api/health', { cache: 'no-store' });
    if (response.ok) {
      online = true;
      const { tools } = await response.json();
      hasGalleryDl = Boolean(tools['gallery-dl']);
      if (hasGalleryDl) {
        label = 'ENGINE ONLINE';
        statusClass = 'is-online';
        setImageOptionsEnabled(true);
      } else {
        label = 'VIDEO / AUDIO ONLY';
        statusClass = 'is-partial';
        setImageOptionsEnabled(false);
      }
    }
  } catch {}
  engineStatus.classList.remove('is-online', 'is-partial', 'is-offline');
  engineStatus.classList.add(statusClass);
  engineStatus.textContent = label;
  engineStatus.title = label;
  engineStatus.setAttribute('aria-label', label);
  return { online, galleryDl: hasGalleryDl };
}

function platformFromUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/\.$/, '');
    const match = PLATFORM_DOMAINS.find(([, domains]) =>
      domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
    );
    return match ? match[0] : '';
  } catch {
    return '';
  }
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

async function requestInfo(url, contentType, signal) {
  const response = await fetch('/api/info', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, contentType }),
    signal
  });
  if (!response.ok) {
    const error = new Error(await readError(response));
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function analyzeMedia(event, { fromShare = false } = {}) {
  event?.preventDefault();
  if (downloadButton.disabled) return false;
  const url = urlInput.value.trim();
  const contentType = selectedContentType();
  setError();

  if (!url) {
    setError('Paste a public media link to continue.');
    urlInput.focus();
    return false;
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') throw new Error('Invalid protocol');
  } catch {
    setError('Enter a complete HTTPS link from a supported site.');
    urlInput.focus();
    return false;
  }

  activeRequest?.abort();
  const request = new AbortController();
  activeRequest = request;
  resultCard.hidden = true;
  setAnalyzeBusy(true);
  setWorking(true, 'Inspecting source...', 'This usually takes a few seconds.');

  try {
    let resolvedType = contentType;
    let media;
    try {
      media = await requestInfo(url, resolvedType, request.signal);
    } catch (error) {
      if (fromShare && resolvedType === 'video' && hasGalleryDl && error.status === 422 && error.name !== 'AbortError') {
        const fallbackMedia = await requestInfo(url, 'carousel', request.signal);
        resolvedType = fallbackMedia.itemCount > 1 ? 'carousel' : 'post';
        contentTypeSelect.value = resolvedType;
        updateContentType();
        media = fallbackMedia;
      } else {
        throw error;
      }
    }

    if (activeRequest !== request || urlInput.value.trim() !== url || selectedContentType() !== resolvedType) return false;
    analyzedUrl = url;
    analyzedContentType = resolvedType;
    showResult(media);
    return true;
  } catch (error) {
    if (activeRequest === request && error.name !== 'AbortError') {
      setError(error.message || 'Could not read this link.');
    }
    return false;
  } finally {
    if (activeRequest === request) {
      activeRequest = null;
      setAnalyzeBusy(false);
      setWorking(false);
    }
  }
}

async function downloadMedia() {
  const contentType = selectedContentType();
  if (
    downloadButton.disabled
    || activeRequest
    || activeDownload
    || !currentMedia
    || analyzedUrl !== urlInput.value.trim()
    || analyzedContentType !== contentType
  ) return;

  const format = selectedFormat();
  const quality = qualitySelect.value;
  const request = new AbortController();
  activeDownload = request;
  downloadButton.disabled = true;
  analyzeButton.disabled = true;
  setError();
  const outputLabel = contentType === 'carousel' ? 'ZIP' : format.toUpperCase();
  setWorking(true, `Preparing ${outputLabel}...`, 'Large files stream straight to your browser once ready.');

  try {
    const response = await fetch('/api/downloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: analyzedUrl,
        format,
        quality,
        contentType,
        title: currentMedia.title
      }),
      signal: request.signal
    });

    if (!response.ok) throw new Error(await readError(response));
    const { downloadUrl, filename } = await response.json();
    if (activeDownload !== request) return;

    const link = document.createElement('a');
    link.href = downloadUrl;
    const extension = contentType === 'carousel' ? 'zip' : format;
    link.download = filename || `social-ripper.${extension}`;
    document.body.append(link);
    link.click();
    link.remove();
  } catch (error) {
    if (activeDownload === request && error.name !== 'AbortError') {
      setError(error.message || 'Could not download this media.');
    }
  } finally {
    if (activeDownload === request) {
      activeDownload = null;
      downloadButton.disabled = false;
      analyzeButton.disabled = false;
      setWorking(false);
    }
  }
}

function cancelActiveWork() {
  if (activeDownload) {
    activeDownload.abort();
    return;
  }
  if (activeRequest) {
    activeRequest.abort();
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

function isStandaloneApp() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function isIosSafari() {
  const ua = window.navigator.userAgent || '';
  const isIosDevice = /iphone|ipad|ipod/i.test(ua)
    || (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
  return isIosDevice && /safari/i.test(ua) && !/crios|fxios|edgios|opios/i.test(ua);
}

function wasInstallDismissedRecently() {
  try {
    const raw = window.localStorage.getItem(INSTALL_DISMISS_KEY);
    const timestamp = Number(raw);
    return Number.isFinite(timestamp) && timestamp > 0 && (Date.now() - timestamp) < INSTALL_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function markInstallDismissed() {
  try {
    window.localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now()));
  } catch {}
}

function isSecureInstallOrigin() {
  return window.location.protocol === 'https:'
    || ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
}

function isMobileContext() {
  return window.matchMedia('(max-width: 1020px), (pointer: coarse)').matches;
}

function setGuideSteps(items) {
  installIosSteps.replaceChildren();
  items.forEach((html) => {
    const li = document.createElement('li');
    li.innerHTML = html;
    installIosSteps.append(li);
  });
}

function showInstallPopup({ mode }) {
  if (isStandaloneApp()) return;
  const isNative = mode === 'native';
  if (isNative) {
    installPopupTitle.textContent = 'Install Social Ripper';
    installPopupCopy.textContent = 'Install the app to share reels, videos, and posts directly from Instagram, TikTok, YouTube & more.';
    installIosSteps.hidden = true;
    installActionButton.hidden = false;
  } else if (mode === 'ios') {
    installPopupTitle.textContent = 'Add Social Ripper to Home Screen';
    installPopupCopy.textContent = 'Install Social Ripper on your Home Screen for full-screen launch and quick link pasting.';
    setGuideSteps([
      'Tap the <strong>Share</strong> button in Safari.',
      'Tap <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.'
    ]);
    installIosSteps.hidden = false;
    installActionButton.hidden = true;
  } else {
    installPopupTitle.textContent = 'Install Social Ripper App';
    installPopupCopy.textContent = isSecureInstallOrigin()
      ? 'Install Social Ripper from your browser menu to share Instagram reels and posts directly to it.'
      : 'Open Social Ripper over HTTPS on your phone to install it and unlock Share → SocialRipper from Instagram & other apps.';
    setGuideSteps(
      isSecureInstallOrigin()
        ? [
            'Open your browser menu (<strong>⋮</strong> or <strong>⋯</strong>).',
            'Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.'
          ]
        : [
            'Access this server via an <strong>HTTPS</strong> URL on mobile.',
            'Tap <strong>Install app</strong> in your browser menu to add <strong>SocialRipper</strong> to Share.'
          ]
    );
    installIosSteps.hidden = false;
    installActionButton.hidden = true;
  }
  installPopup.hidden = false;
}

function hideInstallPopup({ remember = false } = {}) {
  installPopup.hidden = true;
  if (remember) markInstallDismissed();
}

function initPwa() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  if (isStandaloneApp()) return;

  let fallbackTimer = null;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    deferredInstallPrompt = event;
    installNavButton.hidden = false;
    if (!wasInstallDismissedRecently() || !installPopup.hidden) {
      showInstallPopup({ mode: 'native' });
    }
  });

  window.addEventListener('appinstalled', () => {
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    deferredInstallPrompt = null;
    installNavButton.hidden = true;
    hideInstallPopup();
  });

  if (isIosSafari()) {
    installNavButton.hidden = false;
    if (!wasInstallDismissedRecently()) {
      showInstallPopup({ mode: 'ios' });
    }
  } else if (isMobileContext()) {
    installNavButton.hidden = false;
    if (!wasInstallDismissedRecently()) {
      fallbackTimer = setTimeout(() => {
        if (!deferredInstallPrompt && !isStandaloneApp() && !wasInstallDismissedRecently()) {
          showInstallPopup({ mode: 'guide' });
        }
      }, 600);
    }
  }

  installNavButton.addEventListener('click', () => {
    if (deferredInstallPrompt) {
      showInstallPopup({ mode: 'native' });
    } else if (isIosSafari()) {
      showInstallPopup({ mode: 'ios' });
    } else {
      showInstallPopup({ mode: 'guide' });
    }
  });

  installActionButton.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;
    try {
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (choice?.outcome === 'accepted') {
        installNavButton.hidden = true;
        hideInstallPopup();
      } else {
        hideInstallPopup({ remember: true });
      }
    } catch {
      hideInstallPopup({ remember: true });
    }
  });

  installDismissButton.addEventListener('click', () => hideInstallPopup({ remember: true }));
  installCloseButton.addEventListener('click', () => hideInstallPopup({ remember: true }));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !installPopup.hidden) {
      hideInstallPopup({ remember: true });
    }
  });
}

function setShareBanner(message = '') {
  shareBannerText.textContent = message;
  shareBanner.hidden = !message;
}

function extractSharedUrl(params) {
  const candidates = [params.get('url'), params.get('text'), params.get('title')];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = candidate.match(/https:\/\/[^\s<>"']+/i);
    if (!match) continue;
    const cleaned = match[0].replace(/[.,;:!?)\]]+$/, '');
    try {
      const parsed = new URL(cleaned);
      if (parsed.protocol === 'https:') return parsed.toString();
    } catch {}
  }
  return '';
}

function inferContentTypeFromUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
    const isPinterest = host === 'pinterest.com'
      || host.endsWith('.pinterest.com')
      || host === 'pin.it'
      || host.endsWith('.pin.it');
    if (isPinterest && hasGalleryDl) return 'post';
  } catch {}
  return 'video';
}

function platformLabel(platform) {
  const names = {
    instagram: 'INSTAGRAM',
    tiktok: 'TIKTOK',
    youtube: 'YOUTUBE',
    x: 'X / TWITTER',
    facebook: 'FACEBOOK',
    threads: 'THREADS',
    vimeo: 'VIMEO',
    reddit: 'REDDIT',
    pinterest: 'PINTEREST'
  };
  return names[platform] || '';
}

async function handleIncomingShare() {
  const params = new URLSearchParams(window.location.search);
  const isShareRoute = window.location.pathname === '/share-target';
  const hasShareParams = params.has('url') || params.has('text') || params.has('title');
  if (!isShareRoute && !hasShareParams) return;

  const sharedUrl = extractSharedUrl(params);
  window.history.replaceState(null, '', '/');

  await engineStatusReady;
  if (!sharedUrl) {
    const hasRawInput = [params.get('url'), params.get('text'), params.get('title')]
      .some((value) => typeof value === 'string' && value.trim().length > 0);
    if (isShareRoute || hasRawInput) {
      setError('No public HTTPS link was found in the shared content.');
    }
    return;
  }

  clearInspection();
  setError();
  urlInput.value = sharedUrl;
  updatePlatform();

  const inferredType = inferContentTypeFromUrl(sharedUrl);
  contentTypeSelect.value = inferredType;
  updateContentType();

  const sourceName = platformLabel(platformFromUrl(sharedUrl));
  const prefix = sourceName ? `SHARED FROM ${sourceName}` : 'SHARED LINK RECEIVED';
  setShareBanner(`${prefix} — INSPECTING...`);

  const inspected = await analyzeMedia(null, { fromShare: true });
  if (inspected && analyzedUrl === sharedUrl) {
    setShareBanner(`${prefix} — READY TO DOWNLOAD`);
  } else {
    setShareBanner();
  }
}

form.addEventListener('submit', analyzeMedia);
pasteButton.addEventListener('click', pasteUrl);
downloadButton.addEventListener('click', downloadMedia);
cancelButton.addEventListener('click', cancelActiveWork);
qualitySelect.addEventListener('change', updateResultSummary);
formatInputs.forEach((input) => input.addEventListener('change', updateQualityChoices));
contentTypeSelect.addEventListener('change', () => {
  clearInspection();
  updateContentType();
  setError();
});
urlInput.addEventListener('input', () => {
  setError();
  setShareBanner();
  updatePlatform();
  if (urlInput.value.trim() !== analyzedUrl) clearInspection();
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
const engineStatusReady = updateEngineStatus();
initPwa();
handleIncomingShare();
