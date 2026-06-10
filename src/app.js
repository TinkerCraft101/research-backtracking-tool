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

// ─── Tree Rendering (D3.js) ──────────────────────────────────────────

const TREE_NODE_W = 240;
const TREE_NODE_H = 100;
const TREE_NODE_GAP_X = 20;
const TREE_NODE_GAP_Y = 60;

let currentZoom = null;

function renderTree(data) {
    const { root, stats } = data;

    treeStats.textContent = `${stats.downloaded} downloaded · ${stats.paywalled} paywalled · ${stats.not_found} not found · ${stats.total} refs`;

    treeContainer.innerHTML = '';

    const scrollEl = treeContainer.closest('.tree-scroll') || treeContainer.parentElement;
    const containerW = scrollEl.clientWidth;
    const containerH = scrollEl.clientHeight - 56;

    const svg = d3.select(treeContainer)
        .append('svg')
        .attr('width', containerW)
        .attr('height', containerH)
        .style('cursor', 'grab');

    const g = svg.append('g');

    const zoom = d3.zoom()
        .scaleExtent([0.1, 4])
        .on('zoom', (event) => {
            g.attr('transform', event.transform);
            svg.style('cursor', event.sourceEvent ? 'grabbing' : 'grab');
        });

    currentZoom = zoom;
    svg.call(zoom);

    const d3Root = d3.hierarchy(root);
    const nodeCount = d3Root.descendants().length;

    if (nodeCount === 0) return;

    if (nodeCount === 1) {
        renderSingleNode(g, d3Root, containerW, containerH, zoom, svg);
        return;
    }

    const leafCount = d3Root.leaves().length;
    const treeW = Math.max(containerW - 100, leafCount * (TREE_NODE_W + TREE_NODE_GAP_X));
    const treeH = containerH - 120;

    const treeLayout = d3.tree()
        .size([treeW, treeH])
        .separation((a, b) => {
            if (a.parent === b.parent) return 1;
            return 1.5;
        });

    treeLayout(d3Root);

    const allNodes = d3Root.descendants();
    const allLinks = d3Root.links();

    const minX = d3.min(allNodes, d => d.x);
    const maxX = d3.max(allNodes, d => d.x);
    const treeWidth = maxX - minX + TREE_NODE_W + 100;
    const treeHeight = d3.max(allNodes, d => d.y) + TREE_NODE_H + 100;

    const offsetX = -minX + treeWidth / 2;
    const offsetY = 60;

    g.attr('transform', `translate(${offsetX}, ${offsetY})`);

    const linkGroup = g.append('g').attr('class', 'd3-links');
    const nodeGroup = g.append('g').attr('class', 'd3-nodes');

    linkGroup.selectAll('path')
        .data(allLinks)
        .join('path')
        .attr('class', 'd3-link')
        .attr('d', (d) => {
            return `M${d.source.x},${d.source.y + TREE_NODE_H / 2}
                    C${d.source.x},${(d.source.y + d.target.y) / 2}
                     ${d.target.x},${(d.source.y + d.target.y) / 2}
                     ${d.target.x},${d.target.y - TREE_NODE_H / 2}`;
        })
        .style('opacity', 0)
        .transition()
        .duration(500)
        .delay((d, i) => 200 + i * 30)
        .style('opacity', 1);

    const nodeGs = nodeGroup.selectAll('g')
        .data(allNodes)
        .join('g')
        .attr('class', d => {
            const depth = d.depth;
            if (depth === 0) return 'd3-node d3-node-root';
            if (d.children && d.children.length > 0) return 'd3-node d3-node-branch';
            return 'd3-node d3-node-leaf';
        })
        .attr('transform', d => `translate(${d.x - TREE_NODE_W / 2}, ${d.y - TREE_NODE_H / 2})`)
        .style('cursor', 'pointer')
        .on('click', (event, d) => {
            event.stopPropagation();
            const nodeData = d.data;
            if (nodeData.filename) {
                openPdfViewer(nodeData.folder, nodeData.filename, nodeData.title);
            } else if (nodeData.paper_url && d.depth > 0) {
                window.open(nodeData.paper_url, '_blank');
            }
        })
        .style('opacity', 0);

    nodeGs.transition()
        .duration(600)
        .delay((d, i) => 100 + d.depth * 200 + i * 40)
        .style('opacity', 1);

    nodeGs.each(function(d) {
        const el = d3.select(this);
        const nodeData = d.data;
        const isRoot = d.depth === 0;
        const hasChildren = d.children && d.children.length > 0;
        const status = nodeData.status || 'found';

        let strokeColor = 'rgba(255,255,255,0.1)';
        let bgColor = 'rgba(255,255,255,0.04)';
        let opacity = 1;

        if (isRoot) {
            strokeColor = 'rgba(0,212,255,0.3)';
            bgColor = 'rgba(0,212,255,0.08)';
        } else if (hasChildren) {
            strokeColor = 'rgba(96,165,250,0.2)';
        } else {
            strokeColor = 'rgba(52,211,153,0.15)';
        }

        if (status === 'paywalled') opacity = 0.5;
        if (status === 'not_found') opacity = 0.3;

        el.append('rect')
            .attr('width', TREE_NODE_W)
            .attr('height', TREE_NODE_H)
            .attr('rx', 10)
            .attr('fill', bgColor)
            .attr('stroke', strokeColor)
            .attr('stroke-width', 1.5)
            .style('opacity', opacity);

        if (status === 'downloaded') {
            el.append('rect')
                .attr('width', TREE_NODE_W)
                .attr('height', TREE_NODE_H)
                .attr('rx', 10)
                .attr('fill', 'none')
                .attr('stroke', 'rgba(52,211,153,0.3)')
                .attr('stroke-width', 1.5);
        }

        let badgeText = 'REF';
        let badgeColor = 'rgba(52,211,153,0.15)';
        let badgeFg = '#34d399';
        if (isRoot) {
            badgeText = 'PAPER';
            badgeColor = 'rgba(0,212,255,0.15)';
            badgeFg = '#00d4ff';
        } else if (hasChildren) {
            badgeText = 'BRANCH';
            badgeColor = 'rgba(96,165,250,0.12)';
            badgeFg = '#60a5fa';
        }

        const badge = el.append('g')
            .attr('transform', `translate(12, 12)`);
        badge.append('rect')
            .attr('width', badgeText.length * 6.5 + 12)
            .attr('height', 16)
            .attr('rx', 4)
            .attr('fill', badgeColor);
        badge.append('text')
            .attr('x', 6)
            .attr('y', 12)
            .attr('fill', badgeFg)
            .attr('font-size', '9px')
            .attr('font-weight', '600')
            .attr('font-family', 'Inter, sans-serif')
            .attr('letter-spacing', '0.5px')
            .text(badgeText);

        const titleText = el.append('text')
            .attr('x', TREE_NODE_W / 2)
            .attr('y', 44)
            .attr('text-anchor', 'middle')
            .attr('fill', '#f1f5f9')
            .attr('font-size', isRoot ? '13px' : '12px')
            .attr('font-weight', '500')
            .attr('font-family', 'Inter, sans-serif')
            .style('pointer-events', 'none');

        const title = nodeData.title || 'Untitled';
        const maxChars = isRoot ? 38 : 34;
        const displayTitle = title.length > maxChars ? title.slice(0, maxChars) + '…' : title;
        titleText.text(displayTitle);

        const metaY = 60;
        const meta = el.append('text')
            .attr('x', TREE_NODE_W / 2)
            .attr('y', metaY)
            .attr('text-anchor', 'middle')
            .attr('fill', '#475569')
            .attr('font-size', '10px')
            .attr('font-family', 'Inter, sans-serif')
            .style('pointer-events', 'none');

        let metaStr = '';
        if (nodeData.year) metaStr += nodeData.year;
        if (nodeData.authors && nodeData.authors.length > 0) {
            const authors = nodeData.authors.slice(0, 2).join(', ');
            if (metaStr) metaStr += ' · ';
            metaStr += authors;
        }
        if (metaStr.length > 45) metaStr = metaStr.slice(0, 45) + '…';
        meta.text(metaStr);

        const footerY = TREE_NODE_H - 14;
        let statusText = '';
        let statusColor = '#475569';
        if (status === 'downloaded') { statusText = '✓ PDF'; statusColor = '#34d399'; }
        else if (status === 'paywalled') { statusText = '🔒 Paywalled'; statusColor = '#fbbf24'; }
        else if (status === 'not_found') { statusText = '✗ Not Found'; statusColor = '#f87171'; }
        else if (status === 'found') { statusText = '◉ Found'; statusColor = '#60a5fa'; }

        if (statusText) {
            el.append('text')
                .attr('x', 12)
                .attr('y', footerY)
                .attr('fill', statusColor)
                .attr('font-size', '9px')
                .attr('font-weight', '600')
                .attr('font-family', 'Inter, sans-serif')
                .style('pointer-events', 'none')
                .text(statusText);
        }

        if (nodeData.children && nodeData.children.length > 0) {
            el.append('text')
                .attr('x', TREE_NODE_W - 12)
                .attr('y', footerY)
                .attr('text-anchor', 'end')
                .attr('fill', '#475569')
                .attr('font-size', '9px')
                .attr('font-family', 'JetBrains Mono, monospace')
                .style('pointer-events', 'none')
                .text(`${nodeData.children.length} refs`);
        }
    });

    fitToScreen(svg, zoom, treeWidth, treeHeight, containerW, containerH, offsetX, offsetY);
}

function renderSingleNode(g, d3Root, containerW, containerH, zoom, svg) {
    const nodeData = d3Root.data;
    const x = 0;
    const y = 0;

    const nodeG = g.append('g')
        .attr('transform', `translate(${x - TREE_NODE_W / 2}, ${y - TREE_NODE_H / 2})`)
        .style('cursor', 'pointer')
        .on('click', () => {
            if (nodeData.filename) {
                openPdfViewer(nodeData.folder, nodeData.filename, nodeData.title);
            }
        })
        .style('opacity', 0);

    nodeG.transition()
        .duration(600)
        .delay(200)
        .style('opacity', 1);

    nodeG.append('rect')
        .attr('width', TREE_NODE_W)
        .attr('height', TREE_NODE_H)
        .attr('rx', 10)
        .attr('fill', 'rgba(0,212,255,0.08)')
        .attr('stroke', 'rgba(0,212,255,0.3)')
        .attr('stroke-width', 1.5);

    const badge = nodeG.append('g').attr('transform', 'translate(12, 12)');
    badge.append('rect')
        .attr('width', 52)
        .attr('height', 16)
        .attr('rx', 4)
        .attr('fill', 'rgba(0,212,255,0.15)');
    badge.append('text')
        .attr('x', 6)
        .attr('y', 12)
        .attr('fill', '#00d4ff')
        .attr('font-size', '9px')
        .attr('font-weight', '600')
        .attr('font-family', 'Inter, sans-serif')
        .attr('letter-spacing', '0.5px')
        .text('PAPER');

    nodeG.append('text')
        .attr('x', TREE_NODE_W / 2)
        .attr('y', 44)
        .attr('text-anchor', 'middle')
        .attr('fill', '#f1f5f9')
        .attr('font-size', '13px')
        .attr('font-weight', '500')
        .attr('font-family', 'Inter, sans-serif')
        .style('pointer-events', 'none')
        .text(nodeData.title.length > 38 ? nodeData.title.slice(0, 38) + '…' : nodeData.title);

    const meta = nodeG.append('text')
        .attr('x', TREE_NODE_W / 2)
        .attr('y', 60)
        .attr('text-anchor', 'middle')
        .attr('fill', '#475569')
        .attr('font-size', '10px')
        .attr('font-family', 'Inter, sans-serif')
        .style('pointer-events', 'none');

    let metaStr = '';
    if (nodeData.year) metaStr += nodeData.year;
    if (nodeData.authors && nodeData.authors.length > 0) {
        if (metaStr) metaStr += ' · ';
        metaStr += nodeData.authors.slice(0, 2).join(', ');
    }
    meta.text(metaStr.length > 45 ? metaStr.slice(0, 45) + '…' : metaStr);

    const status = nodeData.status || 'found';
    let statusText = '';
    let statusColor = '#475569';
    if (status === 'downloaded') { statusText = '✓ PDF'; statusColor = '#34d399'; }
    else if (status === 'paywalled') { statusText = '🔒 Paywalled'; statusColor = '#fbbf24'; }
    else if (status === 'not_found') { statusText = '✗ Not Found'; statusColor = '#f87171'; }

    if (statusText) {
        nodeG.append('text')
            .attr('x', 12)
            .attr('y', TREE_NODE_H - 14)
            .attr('fill', statusColor)
            .attr('font-size', '9px')
            .attr('font-weight', '600')
            .attr('font-family', 'Inter, sans-serif')
            .style('pointer-events', 'none')
            .text(statusText);
    }

    g.attr('transform', `translate(${containerW / 2}, ${containerH / 2})`);

    const padScale = 0.8;
    svg.call(zoom.transform, d3.zoomIdentity
        .translate(containerW / 2, containerH / 2)
        .scale(padScale)
        .translate(-x, -y));
}

function fitToScreen(svg, zoom, treeWidth, treeHeight, containerW, containerH, offsetX, offsetY) {
    const padScale = 0.85;
    const scaleX = containerW / (treeWidth + 100);
    const scaleY = containerH / (treeHeight + 100);
    const scale = Math.min(scaleX, scaleY, 1) * padScale;

    const tx = containerW / 2 - offsetX * scale;
    const ty = containerH / 2 - offsetY * scale;

    svg.transition()
        .duration(800)
        .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
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

// ─── Tree Zoom Controls ──────────────────────────────────────────────
const treeZoomIn = $('#tree-zoom-in');
const treeZoomOut = $('#tree-zoom-out');
const treeFit = $('#tree-fit');

function getTreeSvg() {
    return d3.select(treeContainer).select('svg');
}

function getTreeZoom() {
    return currentZoom;
}

treeZoomIn.addEventListener('click', () => {
    const svg = getTreeSvg();
    const zoom = getTreeZoom();
    if (svg.node() && zoom) {
        svg.transition().duration(300).call(zoom.scaleBy, 1.3);
    }
});

treeZoomOut.addEventListener('click', () => {
    const svg = getTreeSvg();
    const zoom = getTreeZoom();
    if (svg.node() && zoom) {
        svg.transition().duration(300).call(zoom.scaleBy, 0.7);
    }
});

treeFit.addEventListener('click', () => {
    const svg = getTreeSvg();
    const zoom = getTreeZoom();
    if (svg.node() && zoom) {
        svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
    }
});

document.addEventListener('keydown', (e) => {
    if (!treeScreen.classList.contains('active')) return;
    if (pdfOverlay.classList.contains('active')) return;

    const svg = getTreeSvg();
    const zoom = getTreeZoom();
    if (!svg.node() || !zoom) return;

    if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        svg.transition().duration(300).call(zoom.scaleBy, 1.3);
    }
    if (e.key === '-') {
        e.preventDefault();
        svg.transition().duration(300).call(zoom.scaleBy, 0.7);
    }
    if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
    }
});

// ─── Window Resize Handler ───────────────────────────────────────────
let resizeTimeout = null;
window.addEventListener('resize', () => {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
        if (treeScreen.classList.contains('active') && currentTreeData) {
            renderTree(currentTreeData);
        }
    }, 250);
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
