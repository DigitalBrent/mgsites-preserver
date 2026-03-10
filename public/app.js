'use strict';

const form = document.getElementById('preserve-form');
const urlInput = document.getElementById('url-input');
const preserveBtn = document.getElementById('preserve-btn');
const progressSection = document.getElementById('progress-section');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const statusText = document.getElementById('status-text');
const statPages = document.getElementById('stat-pages');
const statAssets = document.getElementById('stat-assets');
const downloadSection = document.getElementById('download-section');
const downloadLink = document.getElementById('download-link');
const errorSection = document.getElementById('error-section');
const errorText = document.getElementById('error-text');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  // Reset UI
  preserveBtn.disabled = true;
  preserveBtn.textContent = 'Preserving...';
  progressSection.classList.remove('hidden');
  downloadSection.classList.add('hidden');
  errorSection.classList.add('hidden');
  progressBar.style.width = '0%';
  progressText.textContent = '';
  statusText.textContent = 'Starting...';
  statPages.textContent = '0/0';
  statAssets.textContent = '0';

  try {
    const res = await fetch('/api/preserve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to start preservation');
    }

    const { jobId } = await res.json();
    connectSSE(jobId);
  } catch (err) {
    showError(err.message);
    resetButton();
  }
});

function connectSSE(jobId) {
  const source = new EventSource(`/api/progress/${jobId}`);

  source.addEventListener('phase', (e) => {
    const data = JSON.parse(e.data);
    statusText.textContent = data.message;
  });

  source.addEventListener('progress', (e) => {
    const data = JSON.parse(e.data);
    const pct = Math.min(data.percent, 100);
    progressBar.style.width = pct + '%';
    progressText.textContent = pct > 8 ? pct + '%' : '';
    statPages.textContent = `${data.pagesCrawled}/${data.pagesDiscovered}`;
    statAssets.textContent = data.assetsSaved.toString();
  });

  source.addEventListener('complete', (e) => {
    const data = JSON.parse(e.data);
    source.close();
    progressBar.style.width = '100%';
    progressText.textContent = '100%';
    statusText.textContent = 'Preservation complete!';
    downloadLink.href = data.downloadUrl;
    downloadSection.classList.remove('hidden');
    resetButton();
  });

  source.addEventListener('error', (e) => {
    if (e.data) {
      const data = JSON.parse(e.data);
      showError(data.message);
    } else {
      showError('Connection lost. The crawl may still be running.');
    }
    source.close();
    resetButton();
  });
}

function showError(message) {
  errorText.textContent = message;
  errorSection.classList.remove('hidden');
}

function resetButton() {
  preserveBtn.disabled = false;
  preserveBtn.textContent = 'Preserve';
}
