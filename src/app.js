/**
 * Research Backtracker — Frontend Application
 * Handles upload, progress tracking, nested tree rendering, and Chrome-style PDF viewer.
 */

// ─── PDF.js Setup ────────────────────────────────────────────────────
pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// ─── DOM Elements ────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const uploadScreen = $('#upload-screen');
const processingScreen = $('#processing-screen');
const treeScreen = $('#tree-screen');

const uploadCircle = $('#upload-circle');
const fileInput = $('#file-input');

const depthValue = $('#depth-value');
const depthHint = $('#depth-hint');
const depthMinus = $('#depth-minus');
const depthPlus = $('#depth-plus');

const progressFill = $('#progress-fill');
const progressStats = $('#progress-stats');
const progressMessage = $('#progress-message');
const processingTitle = $('#processing-title');

const treeContainer = $('#tree-container');
const treeStats = $('#tree-stats');
const backBtn = $('#back-btn');

// PDF viewer elements
const pdfOverlay = $('#pdf-overlay');
const pdfBody = $('#pdf-body');
const pdfViewport = $('#pdf-viewport');
const pdfPages = $('#pdf-pages');
const pdfCloseBtn = $('#pdf-close-btn');
const pdfTitle = $('#pdf-title');
const pdfPrev = $('#pdf-prev');
const pdfNext = $('#pdf-next');
const pdfPageInfo = $('#pdf-page-info');
const pdfZoomIn = $('#pdf-zoom-in');
const pdfZoomOut = $('#pdf-zoom-out');
const pdfZoomLevel = $('#pdf-zoom-level');

// ─── State ───────────────────────────────────────────────────────────
let currentTreeData = null;
let pdfDoc = null;
let pdfPagesData = [];
let currentScale = 1.0;
let currentPdfUrl = '';

// ─── Depth Setting ──────────────────────────────────────────────────
let treeDepth = 2;

const depthLabels = ['', 'Root → References', 'Root → References → Sub-refs', '3 levels deep', '4 levels deep', '5 levels deep'];

function updateDepthDisplay() {
    depthValue.textContent = treeDepth;
    depthHint.textContent = depthLabels[treeDepth] || `${treeDepth} levels deep`;
}

depthMinus.addEventListener('click', () => {
    if (treeDepth > 1) { treeDepth--; updateDepthDisplay(); }
});
depthPlus.addEventListener('click', () => {
    if (treeDepth < 5) { treeDepth++; updateDepthDisplay(); }
});

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
        const url = `/api/upload?depth=${treeDepth}`;
        const resp = await fetch(url, { method: 'POST', body: formData });
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

        progressFill.style.width = `${Math.min(pct, 100)}%`;
        progressStats.textContent = `${data.current} / ${data.total}`;
        progressMessage.textContent = data.message;

        if (data.status === 'done') {
            evtSource.close();
            currentTreeData = data.tree_data;
            setTimeout(() => {
                renderTree(data.tree_data);
                showScreen(treeScreen);
            }, 600);
        } else if (data.status === 'error') {
            evtSource.close();
            progressMessage.textContent = data.message || 'An error occurred';
            setTimeout(() => showScreen(uploadScreen), 3000);
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
    const { root, stats } = data;

    treeStats.textContent = `${stats.downloaded} downloaded · ${stats.paywalled} paywalled · ${stats.not_found} not found · ${stats.total} refs`;

    treeContainer.innerHTML = '';

    // Render root node
    const rootEl = createNodeElement(root, true);
    rootEl.addEventListener('click', (e) => {
        e.stopPropagation();
        if (root.filename) {
            openPdfViewer(root.folder, root.filename, root.title);
        }
    });
    treeContainer.appendChild(rootEl);

    // Root connector
    const rootConn = document.createElement('div');
    rootConn.className = 't-connector';
    treeContainer.appendChild(rootConn);

    // Render children (branches)
    if (root.children && root.children.length > 0) {
        const branchesWrap = document.createElement('div');
        branchesWrap.className = 'branches-wrapper';
        root.children.forEach((branch) => {
            const branchCol = document.createElement('div');
            branchCol.className = 'branch-column';

            // Horizontal connector from trunk
            const hConn = document.createElement('div');
            hConn.className = 't-hconnector';
            branchCol.appendChild(hConn);

            // Vertical connector
            const vConn = document.createElement('div');
            vConn.className = 't-connector-short';
            branchCol.appendChild(vConn);

            // Branch node
            const branchEl = createNodeElement(branch, false);
            branchEl.addEventListener('click', (e) => {
                e.stopPropagation();
                if (branch.filename) {
                    openPdfViewer(branch.folder, branch.filename, branch.title);
                } else if (branch.paper_url) {
                    window.open(branch.paper_url, '_blank');
                }
            });
            branchCol.appendChild(branchEl);

            // Leaves section (if any)
            if (branch.children && branch.children.length > 0) {
                const leafConn = document.createElement('div');
                leafConn.className = 't-connector-short';
                branchCol.appendChild(leafConn);

                const leavesWrap = document.createElement('div');
                leavesWrap.className = 'leaves-wrapper';
                branch.children.forEach((leaf) => {
                    const leafEl = createNodeElement(leaf, false, true);
                    leafEl.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (leaf.filename) {
                            openPdfViewer(leaf.folder, leaf.filename, leaf.title);
                        } else if (leaf.paper_url) {
                            window.open(leaf.paper_url, '_blank');
                        }
                    });
                    leavesWrap.appendChild(leafEl);
                });
                branchCol.appendChild(leavesWrap);
            }

            branchesWrap.appendChild(branchCol);
        });
        treeContainer.appendChild(branchesWrap);
    }
}

function createNodeElement(node, isRoot = false, isLeaf = false) {
    const el = document.createElement('div');
    el.className = 't-node';

    if (isRoot) {
        el.classList.add('t-node-root');
    } else if (isLeaf) {
        el.classList.add('t-node-leaf');
    } else {
        el.classList.add('t-node-branch');
    }

    const status = node.status || 'found';
    if (status === 'downloaded') el.classList.add('t-node-available');
    else if (status === 'paywalled') el.classList.add('t-node-paywalled');
    else if (status === 'not_found') el.classList.add('t-node-missing');

    let badge = '';
    if (isRoot) badge = '<span class="t-badge t-badge-root">Paper</span>';
    else if (isLeaf) badge = '<span class="t-badge t-badge-leaf">Ref</span>';
    else badge = '<span class="t-badge t-badge-branch">Branch</span>';

    const authorsStr = node.authors && node.authors.length > 0
        ? node.authors.join(', ')
        : '';

    let statusLabel = '';
    if (status === 'downloaded') statusLabel = '<span class="t-status t-status-dl">✓ PDF</span>';
    else if (status === 'paywalled') statusLabel = '<span class="t-status t-status-pw">🔒 Paywalled</span>';
    else if (status === 'not_found') statusLabel = '<span class="t-status t-status-nf">✗ Not Found</span>';
    else if (status === 'found') statusLabel = '<span class="t-status t-status-fd">◉ Found</span>';

    const count = node.children && node.children.length > 0
        ? `<span class="t-child-count">${node.children.length} refs</span>`
        : '';

    let yearHtml = node.year ? `<span class="t-year">${node.year}</span> · ` : '';

    el.innerHTML = `
        ${badge}
        <div class="t-title">${escHtml(node.title)}</div>
        <div class="t-meta">
            ${yearHtml}${escHtml(authorsStr)}
        </div>
        <div class="t-footer">
            ${statusLabel}
            ${count}
        </div>
    `;

    if (node.paper_url && !isRoot) {
        el.dataset.url = node.paper_url;
    }

    return el;
}

// ─── PDF Viewer (Chrome-style) ──────────────────────────────────────

function openPdfViewer(folder, filename, title) {
    if (!folder || !filename) return;
    pdfTitle.textContent = title;
    currentPdfUrl = `/api/pdf/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`;
    currentScale = 1.0;
    pdfZoomLevel.textContent = '100%';
    pdfPages.innerHTML = '<div class="pdf-loading">Loading PDF...</div>';
    pdfOverlay.classList.add('active');
    pdfBody.scrollTop = 0;

    loadPdfDocument(currentPdfUrl);
}

async function loadPdfDocument(url) {
    try {
        pdfDoc = await pdfjsLib.getDocument(url).promise;
        pdfPagesData = [];
        pdfPages.innerHTML = '';
        pdfPageInfo.textContent = `1 / ${pdfDoc.numPages}`;
        renderAllPages();
    } catch (err) {
        pdfPages.innerHTML = '<div class="pdf-loading">Failed to load PDF</div>';
    }
}

async function renderAllPages() {
    if (!pdfDoc) return;
    pdfPages.innerHTML = '';
    pdfPagesData = [];

    for (let i = 1; i <= pdfDoc.numPages; i++) {
        const pageContainer = document.createElement('div');
        pageContainer.className = 'pdf-page-container';
        pageContainer.dataset.page = i;
        pdfPages.appendChild(pageContainer);
    }

    // Render pages in batches for responsiveness
    const batchSize = 4;
    for (let i = 1; i <= pdfDoc.numPages; i += batchSize) {
        const batch = [];
        for (let j = i; j < Math.min(i + batchSize, pdfDoc.numPages + 1); j++) {
            batch.push(renderPage(j));
        }
        await Promise.all(batch);
        // Allow UI to breathe
        await new Promise(r => setTimeout(r, 10));
    }

    updateVisiblePage();
}

async function renderPage(pageNum) {
    try {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: currentScale });

        const container = pdfPages.querySelector(`[data-page="${pageNum}"]`);
        if (!container) return;

        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-page-canvas';
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        container.appendChild(canvas);

        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport }).promise;

        pdfPagesData[pageNum] = { page, viewport };
    } catch (err) {
        // Skip failed page
    }
}

async function reRenderAllPages() {
    if (!pdfDoc) return;
    pdfPages.innerHTML = '';
    pdfPagesData = [];

    for (let i = 1; i <= pdfDoc.numPages; i++) {
        const container = document.createElement('div');
        container.className = 'pdf-page-container';
        container.dataset.page = i;
        pdfPages.appendChild(container);
    }

    const batchSize = 4;
    for (let i = 1; i <= pdfDoc.numPages; i += batchSize) {
        const batch = [];
        for (let j = i; j < Math.min(i + batchSize, pdfDoc.numPages + 1); j++) {
            batch.push(renderPage(j));
        }
        await Promise.all(batch);
        await new Promise(r => setTimeout(r, 10));
    }

    updateVisiblePage();
}

// ─── Zoom ────────────────────────────────────────────────────────────
function zoomIn() {
    if (currentScale >= 3.0) return;
    currentScale = Math.round((currentScale + 0.25) * 100) / 100;
    pdfZoomLevel.textContent = `${Math.round(currentScale * 100)}%`;
    reRenderAllPages();
}

function zoomOut() {
    if (currentScale <= 0.25) return;
    currentScale = Math.round((currentScale - 0.25) * 100) / 100;
    pdfZoomLevel.textContent = `${Math.round(currentScale * 100)}%`;
    reRenderAllPages();
}

pdfZoomIn.addEventListener('click', zoomIn);
pdfZoomOut.addEventListener('click', zoomOut);

// ─── Page Navigation ────────────────────────────────────────────────
function goToPage(pageNum) {
    if (!pdfDoc) return;
    const page = Math.max(1, Math.min(pageNum, pdfDoc.numPages));
    const container = pdfPages.querySelector(`[data-page="${page}"]`);
    if (container) {
        container.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    pdfPageInfo.textContent = `${page} / ${pdfDoc.numPages}`;
}

pdfPrev.addEventListener('click', () => {
    if (!pdfDoc) return;
    const current = getVisiblePage();
    goToPage(current - 1);
});

pdfNext.addEventListener('click', () => {
    if (!pdfDoc) return;
    const current = getVisiblePage();
    goToPage(current + 1);
});

function getVisiblePage() {
    const containers = pdfPages.querySelectorAll('.pdf-page-container');
    let bestPage = 1;
    let bestDist = Infinity;
    const scrollTop = pdfBody.scrollTop;
    const bodyHeight = pdfBody.clientHeight;
    const midPoint = scrollTop + bodyHeight / 2;

    containers.forEach((c) => {
        const rect = c.getBoundingClientRect();
        const bodyRect = pdfBody.getBoundingClientRect();
        const cMid = rect.top - bodyRect.top + rect.height / 2;
        const dist = Math.abs(cMid - bodyHeight / 2);
        if (dist < bestDist) {
            bestDist = dist;
            bestPage = parseInt(c.dataset.page) || 1;
        }
    });
    return bestPage;
}

function updateVisiblePage() {
    if (!pdfDoc) return;
    const page = getVisiblePage();
    pdfPageInfo.textContent = `${page} / ${pdfDoc.numPages}`;
}

// ─── PDF Viewer Scroll Handling ─────────────────────────────────────
let scrollTimeout = null;
pdfBody.addEventListener('scroll', () => {
    if (scrollTimeout) clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(updateVisiblePage, 150);
});

// ─── PDF Viewer Close ───────────────────────────────────────────────
pdfCloseBtn.addEventListener('click', closePdfViewer);
pdfOverlay.addEventListener('click', (e) => {
    if (e.target === pdfOverlay || e.target === pdfBody || e.target === pdfViewport) {
        closePdfViewer();
    }
});

function closePdfViewer() {
    pdfOverlay.classList.remove('active');
    pdfDoc = null;
    pdfPagesData = [];
    pdfPages.innerHTML = '';
}

// ─── Keyboard Navigation ─────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
    if (!pdfOverlay.classList.contains('active')) return;
    if (e.key === 'Escape') closePdfViewer();
    if (e.key === 'ArrowLeft') pdfPrev.click();
    if (e.key === 'ArrowRight') pdfNext.click();
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomIn(); }
    if (e.key === '-') { e.preventDefault(); zoomOut(); }
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
