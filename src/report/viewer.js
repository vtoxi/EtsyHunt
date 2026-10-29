(async () => {
  const titleEl = document.getElementById('title');
  const subtitleEl = document.getElementById('subtitle');
  const frame = document.getElementById('frame');
  const empty = document.getElementById('empty');
  const btnDownload = document.getElementById('btn-download');
  const btnClose = document.getElementById('btn-close');

  let report = null;

  try {
    const data = await chrome.storage.local.get('lastReport');
    report = data.lastReport || null;
  } catch (e) {
    empty.textContent = `Could not load report: ${e.message}`;
    empty.style.display = 'block';
    btnDownload.disabled = true;
    return;
  }

  if (!report || !report.html) {
    empty.style.display = 'block';
    subtitleEl.textContent = report && report.htmlStored === false
      ? 'Report was too large to keep in storage — use Download from the popup after regenerating, or re-run Step 4.'
      : 'No saved report';
    btnDownload.disabled = true;
    return;
  }

  const seed = report.seedKeyword || 'Research report';
  const verdict = report.verdict ? ` · ${report.verdict}` : '';
  const partialBadge = report.partial ? ' <span class="badge">PARTIAL</span>' : '';
  titleEl.innerHTML = `${escapeHtml(seed)}${partialBadge}`;
  const stepNote = report.partial && report.stoppedAfterStep
    ? ` · stopped after Step ${report.stoppedAfterStep}`
    : '';
  subtitleEl.textContent = `${report.filename || 'report.html'}${verdict}${stepNote}`;

  frame.srcdoc = report.html;
  frame.style.display = 'block';

  btnDownload.addEventListener('click', () => {
    const blob = new Blob([report.html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = report.filename || 'etsyhunt_report.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  btnClose.addEventListener('click', () => window.close());

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();
