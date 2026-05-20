/**
 * Research Backtracker — Frontend Application
 * Handles upload, progress tracking, tree rendering, and PDF viewing.
 */

// ─── PDF.js Setup ────────────────────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ─── DOM Elements ────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);

const uploadScreen = $('#upload-screen');
const processingScreen = $('#processing-screen');
const treeScreen = $('#tree-screen');

const uploadCircle = $('#upload-circle');
const fileInput = $('#file-input');

const progressFill = $('#progress-fill');
const progressStats = $('#progress-stats');
const progressMessage = $('#progress-message');
const processingTitle = $('#processing-title');

const treeContainer = $('#tree-container');
const treeStats = $('#tree-stats');
const backBtn = $('#back-btn');

const pdfOverlay = $('#pdf-overlay');
const pdfPanel = $('#pdf-panel');
const pdfCloseBtn = $('#pdf-close-btn');
const pdfTitle = $('#pdf-title');
const pdfPrev = $('#pdf-prev');
const pdfNext = $('#pdf-next');
const pdfPageInfo = $('#pdf-page-info');
const pdfCanvas = $('#pdf-canvas');
const pdfCanvasWrapper = $('#pdf-canvas-wrapper');

// ─── State ───────────────────────────────────────────────────────────
let currentTreeData = null;
let pdfDoc = null;
let currentPage = 1;
let totalPages = 0;
let renderingPage = false;

// ─── Screen Management ──────────────────────────────────────────────
function showScreen(screen) {
    [uploadScreen, processingScreen, treeScreen].forEach((s) => {
        s.classList.remove('active');
    });
    screen.classList.add('active');
}

// ─── Upload Handling ─────────────────────────────────────────────────
uploadCircle.addEventListener('click', () => fileInput.click());

uploadCircle.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadCircle.classList.add('drag-over');
});

uploadCircle.addEventListener('dragleave', () => {
    uploadCircle.classList.remove('drag-over');
});

uploadCircle.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadCircle.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/pdf') {
        uploadFile(file);
    }
});

fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) {
        uploadFile(fileInput.files[0]);
    }
});

async function uploadFile(file) {
    showScreen(processingScreen);
    processingTitle.textContent = 'Parsing Paper...';
    progressMessage.textContent = 'Uploading and extracting text...';
    progressFill.style.width = '0%';
    progressStats.textContent = '';

    const formData = new FormData();
    formData.append('file', file);

    try {
        const resp = await fetch('/api/upload', { method: 'POST', body: formData });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.detail || 'Upload failed');
        }
        const data = await resp.json();
        processingTitle.textContent = truncate(data.paper_title, 60);
        progressStats.textContent = `0 / ${data.total_references}`;

        if (data.total_references === 0) {
            progressMessage.textContent = 'No references found in this paper.';
            setTimeout(() => showScreen(uploadScreen), 2500);
            return;
        }

        // Connect to SSE for progress
        trackProgress(data.job_id);
    } catch (err) {
        progressMessage.textContent = `Error: ${err.message}`;
        setTimeout(() => showScreen(uploadScreen), 3000);
    }
}

// ─── Progress Tracking (SSE) ─────────────────────────────────────────
function trackProgress(jobId) {
    const evtSource = new EventSource(`/api/progress/${jobId}`);

    evtSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        const pct = data.total > 0 ? (data.current / data.total) * 100 : 0;

        progressFill.style.width = `${pct}%`;
        progressStats.textContent = `${data.current} / ${data.total}`;
        progressMessage.textContent = data.message;

        if (data.status === 'done') {
            evtSource.close();
            currentTreeData = data.tree_data;
            setTimeout(() => {
                renderTree(data.tree_data);
                showScreen(treeScreen);
            }, 600);
        }
    };

    evtSource.onerror = () => {
        evtSource.close();
        progressMessage.textContent = 'Connection lost. Please try again.';
        setTimeout(() => showScreen(uploadScreen), 3000);
    };
}

// ─── Tree Rendering ──────────────────────────────────────────────────
function renderTree(data) {
    const { root, children, stats } = data;

    // Stats header
    treeStats.textContent = `${stats.downloaded} downloaded · ${stats.paywalled} unavailable · ${stats.total} total`;

    // Clear previous tree
    treeContainer.innerHTML = '';

    // Root node
    const rootEl = document.createElement('div');
    rootEl.className = 'root-node';
    rootEl.innerHTML = `
        <span class="node-label">Root Paper</span>
        <span class="node-title">${escHtml(root.title)}</span>
    `;
    rootEl.addEventListener('click', () => {
        openPdfViewer(root.folder, root.filename, root.title, rootEl);
    });
    treeContainer.appendChild(rootEl);

    // Trunk line
    const trunk = document.createElement('div');
    trunk.className = 'tree-trunk';
    treeContainer.appendChild(trunk);

    // Horizontal branch
    const branchLine = document.createElement('div');
    branchLine.className = 'tree-branch-line';
    treeContainer.appendChild(branchLine);

    // Children container
    const childrenWrap = document.createElement('div');
    childrenWrap.className = 'children-container';

    children.forEach((child) => {
        const branch = document.createElement('div');
        branch.className = 'child-branch';

        // Connector
        const connector = document.createElement('div');
        connector.className = 'child-connector';
        branch.appendChild(connector);

        // Node
        const node = document.createElement('div');
        const isAvailable = child.downloaded && child.filename;
        node.className = `child-node ${isAvailable ? 'available' : 'paywalled'}`;

        const authorsStr = child.authors && child.authors.length > 0
            ? child.authors.join(', ')
            : 'Unknown authors';

        let statusHtml = '';
        if (isAvailable) {
            statusHtml = '<span class="node-status downloaded">✓ PDF Available</span>';
        } else {
            statusHtml = '<span class="node-status paywalled">Unavailable</span>';
        }

        let webBtnHtml = '';
        if (!isAvailable && child.paper_url) {
            webBtnHtml = `<a class="view-web-btn" href="${escHtml(child.paper_url)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">View on Web ↗</a>`;
        }

        node.innerHTML = `
            <div class="node-title">${escHtml(child.title)}</div>
            <div class="node-meta">
                ${child.year ? `<span class="year">${child.year}</span> · ` : ''}${escHtml(authorsStr)}
            </div>
            ${statusHtml}
            ${webBtnHtml}
        `;

        if (isAvailable) {
            node.addEventListener('click', () => {
                openPdfViewer(
                    currentTreeData.root.folder,
                    child.filename,
                    child.title,
                    node
                );
            });
        }

        branch.appendChild(node);
        childrenWrap.appendChild(branch);
    });

    treeContainer.appendChild(childrenWrap);
}

// ─── PDF Viewer ──────────────────────────────────────────────────────
function openPdfViewer(folder, filename, title, sourceEl) {
    pdfTitle.textContent = title;
    currentPage = 1;
    pdfPageInfo.textContent = '...';

    // Get source element position for animation origin
    const rect = sourceEl.getBoundingClientRect();
    pdfPanel.style.top = `${rect.top}px`;
    pdfPanel.style.left = `${rect.left}px`;
    pdfPanel.style.width = `${rect.width}px`;
    pdfPanel.style.height = `${rect.height}px`;

    // Force reflow then animate
    pdfPanel.offsetHeight;
    pdfOverlay.classList.add('active');

    // Load PDF
    const url = `/api/pdf/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`;
    loadPdf(url);
}

async function loadPdf(url) {
    try {
        pdfDoc = await pdfjsLib.getDocument(url).promise;
        totalPages = pdfDoc.numPages;
        currentPage = 1;
        renderPage(currentPage);
    } catch (err) {
        console.error('PDF load error:', err);
        pdfPageInfo.textContent = 'Load error';
    }
}

async function renderPage(pageNum) {
    if (renderingPage || !pdfDoc) return;
    renderingPage = true;

    try {
        const page = await pdfDoc.getPage(pageNum);
        const wrapperWidth = pdfCanvasWrapper.clientWidth - 48;
        const unscaledViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(wrapperWidth / unscaledViewport.width, 2.0);
        const viewport = page.getViewport({ scale });

        pdfCanvas.width = viewport.width;
        pdfCanvas.height = viewport.height;

        await page.render({
            canvasContext: pdfCanvas.getContext('2d'),
            viewport,
        }).promise;

        pdfPageInfo.textContent = `${pageNum} / ${totalPages}`;
    } catch (err) {
        console.error('Render error:', err);
    }

    renderingPage = false;
}

pdfPrev.addEventListener('click', () => {
    if (currentPage > 1) {
        currentPage--;
        renderPage(currentPage);
    }
});

pdfNext.addEventListener('click', () => {
    if (currentPage < totalPages) {
        currentPage++;
        renderPage(currentPage);
    }
});

pdfCloseBtn.addEventListener('click', closePdfViewer);

pdfOverlay.addEventListener('click', (e) => {
    if (e.target === pdfOverlay) closePdfViewer();
});

function closePdfViewer() {
    pdfOverlay.classList.remove('active');
    setTimeout(() => {
        pdfDoc = null;
        pdfCanvas.width = 0;
        pdfCanvas.height = 0;
    }, 500);
}

// Keyboard navigation
document.addEventListener('keydown', (e) => {
    if (!pdfOverlay.classList.contains('active')) return;
    if (e.key === 'Escape') closePdfViewer();
    if (e.key === 'ArrowLeft') pdfPrev.click();
    if (e.key === 'ArrowRight') pdfNext.click();
});

// ─── Back Button ─────────────────────────────────────────────────────
backBtn.addEventListener('click', () => {
    currentTreeData = null;
    treeContainer.innerHTML = '';
    fileInput.value = '';
    showScreen(uploadScreen);
});

// ─── Utilities ───────────────────────────────────────────────────────
function escHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}

function truncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max) + '…' : str;
}
