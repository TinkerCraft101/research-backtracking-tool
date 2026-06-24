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

// ─── Tree Rendering (D3.js) — Radial + Semantic Zoom + Clusters ─────

const RADIAL_NODE_W = 190;
const RADIAL_NODE_H = 74;
const CLUSTER_INNER_R = 14;
const CLUSTER_OUTER_R = 22;

let currentZoom = null;
let currentZoomTransform = null;
let cachedAllNodes = [];
let cachedNodeGroup = null;
let cachedLinkGroup = null;
let cachedZoomLevelId = -1;
let cachedCenterX = 0;
let cachedCenterY = 0;

const ZOOM_LEVELS = [
    { maxScale: 0.3,  maxDepth: 0, label: 'Continent' },
    { maxScale: 0.7,  maxDepth: 1, label: 'Country' },
    { maxScale: 1.5,  maxDepth: 2, label: 'City' },
    { maxScale: Infinity, maxDepth: Infinity, label: 'Street' },
];

const STATUS_COLORS = {
    downloaded: '#34d399',
    paywalled: '#fbbf24',
    not_found: '#f87171',
    found: '#60a5fa',
};

function getZoomLevel(scale) {
    for (let i = 0; i < ZOOM_LEVELS.length; i++) {
        if (scale <= ZOOM_LEVELS[i].maxScale) return i;
    }
    return ZOOM_LEVELS.length - 1;
}

function getZoomLevelInfo(id) {
    return ZOOM_LEVELS[id] || ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
}

function renderTree(data) {
    const { root, stats } = data;

    treeStats.textContent = `${stats.downloaded} downloaded \u00B7 ${stats.paywalled} paywalled \u00B7 ${stats.not_found} not found \u00B7 ${stats.total} refs`;

    treeContainer.innerHTML = '';

    const scrollEl = treeContainer.closest('.tree-scroll') || treeContainer.parentElement;
    const containerW = scrollEl.clientWidth;
    const containerH = scrollEl.clientHeight - 56;

    cachedCenterX = containerW / 2;
    cachedCenterY = containerH / 2;

    const svg = d3.select(treeContainer).append('svg')
        .attr('width', containerW)
        .attr('height', containerH)
        .style('cursor', 'grab');

    const g = svg.append('g');
    const zoom = d3.zoom()
        .scaleExtent([0.1, 6])
        .on('zoom', (event) => {
            currentZoomTransform = event.transform;
            g.attr('transform', event.transform);
            svg.style('cursor', event.sourceEvent ? 'grabbing' : 'grab');
            onZoomTransform(event.transform.k);
        });

    currentZoom = zoom;
    svg.call(zoom);

    const d3Root = d3.hierarchy(root);
    const allNodes = d3Root.descendants();
    if (allNodes.length === 0) return;

    if (allNodes.length === 1) {
        renderSingleRadialNode(g, d3Root, containerW, containerH, zoom, svg);
        return;
    }

    const maxRadius = Math.max(containerW, containerH) * 0.45;
    const treeLayout = d3.tree()
        .size([2 * Math.PI, maxRadius])
        .separation((a, b) => (a.parent === b.parent ? 1 : 1.2));

    treeLayout(d3Root);

    allNodes.forEach(d => {
        const angle = d.x - Math.PI / 2;
        d.px = cachedCenterX + d.y * Math.cos(angle);
        d.py = cachedCenterY + d.y * Math.sin(angle);
    });

    cachedAllNodes = allNodes;

    cachedLinkGroup = g.append('g').attr('class', 'd3-links');
    const allLinks = d3Root.links();
    cachedLinkGroup.selectAll('path')
        .data(allLinks)
        .join('path')
        .attr('class', 'd3-link')
        .attr('d', d => {
            const mx = (d.source.px + d.target.px) / 2;
            const my = (d.source.py + d.target.py) / 2;
            return `M${d.source.px},${d.source.py} Q${mx},${my} ${d.target.px},${d.target.py}`;
        })
        .style('opacity', 0)
        .transition()
        .duration(500)
        .delay((d, i) => 200 + i * 30)
        .style('opacity', 1);

    cachedNodeGroup = g.append('g').attr('class', 'd3-nodes');
    const nodeGs = cachedNodeGroup.selectAll('g')
        .data(allNodes)
        .join('g')
        .attr('class', d => {
            if (d.depth === 0) return 'd3-node-group d3-node-root';
            return (d.data.children && d.data.children.length > 0)
                ? 'd3-node-group d3-node-branch' : 'd3-node-group d3-node-leaf';
        })
        .attr('transform', d => `translate(${d.px}, ${d.py})`)
        .style('cursor', 'pointer')
        .style('opacity', 0)
        .on('click', (event, d) => {
            event.stopPropagation();
            const nodeData = d.data;
            if (nodeData.filename) {
                openPdfViewer(nodeData.folder, nodeData.filename, nodeData.title);
            } else if (nodeData.paper_url && d.depth > 0) {
                window.open(nodeData.paper_url, '_blank');
            }
        });

    nodeGs.transition()
        .duration(600)
        .delay((d, i) => 100 + d.depth * 200 + i * 40)
        .style('opacity', 1);

    nodeGs.each(function(d) { renderRadialNodeContent(d3.select(this), d); });

    cachedZoomLevelId = -1;
    onZoomTransform(1);

    fitRadialToScreen(svg, zoom, maxRadius, containerW, containerH);
}

function fitRadialToScreen(svg, zoom, maxRadius, containerW, containerH) {
    const pad = 80;
    const fitR = Math.min(containerW, containerH) * 0.5 - pad;
    const scale = Math.min(1, fitR / (maxRadius + RADIAL_NODE_W));
    svg.transition().duration(800)
        .call(zoom.transform, d3.zoomIdentity
            .translate(cachedCenterX, cachedCenterY)
            .scale(scale)
            .translate(-cachedCenterX, -cachedCenterY));
}

function renderSingleRadialNode(g, d3Root, containerW, containerH, zoom, svg) {
    const nodeData = d3Root.data;
    const cx = containerW / 2, cy = containerH / 2;

    const ng = g.append('g')
        .attr('transform', `translate(${cx}, ${cy})`)
        .style('cursor', 'pointer')
        .on('click', () => {
            if (nodeData.filename) openPdfViewer(nodeData.folder, nodeData.filename, nodeData.title);
        });

    ng.append('rect')
        .attr('x', -RADIAL_NODE_W / 2).attr('y', -RADIAL_NODE_H / 2)
        .attr('width', RADIAL_NODE_W).attr('height', RADIAL_NODE_H)
        .attr('rx', 10).attr('fill', 'rgba(0,212,255,0.08)')
        .attr('stroke', 'rgba(0,212,255,0.3)').attr('stroke-width', 1.5);

    const badge = ng.append('g').attr('transform', `translate(${-RADIAL_NODE_W / 2 + 10}, ${-RADIAL_NODE_H / 2 + 10})`);
    badge.append('rect').attr('width', 52).attr('height', 16).attr('rx', 4).attr('fill', 'rgba(0,212,255,0.15)');
    badge.append('text').attr('x', 6).attr('y', 12).attr('fill', '#00d4ff')
        .attr('font-size', '9px').attr('font-weight', '600')
        .attr('font-family', 'Inter, sans-serif').text('PAPER');

    ng.append('text').attr('text-anchor', 'middle').attr('y', 4)
        .attr('fill', '#f1f5f9').attr('font-size', '13px').attr('font-weight', '500')
        .attr('font-family', 'Inter, sans-serif')
        .text(nodeData.title.length > 36 ? nodeData.title.slice(0, 36) + '\u2026' : nodeData.title);

    const status = nodeData.status || 'found';
    let st = '', sc = '#475569';
    if (status === 'downloaded') { st = '\u2713 PDF'; sc = '#34d399'; }
    else if (status === 'paywalled') { st = '\uD83D\uDD12 Paywalled'; sc = '#fbbf24'; }
    else if (status === 'not_found') { st = '\u2717 Not Found'; sc = '#f87171'; }
    if (st) {
        ng.append('text').attr('x', -RADIAL_NODE_W / 2 + 10).attr('y', RADIAL_NODE_H / 2 - 8)
            .attr('fill', sc).attr('font-size', '9px').attr('font-weight', '600')
            .attr('font-family', 'Inter, sans-serif').text(st);
    }

    svg.call(zoom.transform, d3.zoomIdentity.translate(cx, cy).scale(0.6));
}

function renderRadialNodeContent(el, d) {
    const nodeData = d.data;
    const isRoot = d.depth === 0;
    const hasChildren = nodeData.children && nodeData.children.length > 0;
    const status = nodeData.status || 'found';

    const nodeW = isRoot ? RADIAL_NODE_W : RADIAL_NODE_W - 16;
    const nodeH = isRoot ? RADIAL_NODE_H : RADIAL_NODE_H - 8;
    const opacity = status === 'paywalled' ? 0.5 : status === 'not_found' ? 0.3 : 1;

    let stroke = 'rgba(255,255,255,0.1)';
    let bg = 'rgba(255,255,255,0.04)';
    if (isRoot) { stroke = 'rgba(0,212,255,0.3)'; bg = 'rgba(0,212,255,0.08)'; }
    else if (hasChildren) { stroke = 'rgba(96,165,250,0.2)'; }
    else { stroke = 'rgba(52,211,153,0.15)'; }

    const inner = el.append('g').attr('class', 'd3-node-inner')
        .attr('transform', `translate(${-nodeW / 2}, ${-nodeH / 2})`);

    inner.append('rect').attr('width', nodeW).attr('height', nodeH)
        .attr('rx', 8).attr('fill', bg).attr('stroke', stroke)
        .attr('stroke-width', 1.5).style('opacity', opacity);

    if (status === 'downloaded') {
        inner.append('rect').attr('width', nodeW).attr('height', nodeH)
            .attr('rx', 8).attr('fill', 'none')
            .attr('stroke', 'rgba(52,211,153,0.3)').attr('stroke-width', 1.5);
    }

    let badgeText = 'REF', badgeBg = 'rgba(52,211,153,0.15)', badgeFg = '#34d399';
    if (isRoot) { badgeText = 'PAPER'; badgeBg = 'rgba(0,212,255,0.15)'; badgeFg = '#00d4ff'; }
    else if (hasChildren) { badgeText = 'BRANCH'; badgeBg = 'rgba(96,165,250,0.12)'; badgeFg = '#60a5fa'; }

    const badge = inner.append('g').attr('transform', 'translate(8, 8)');
    badge.append('rect').attr('width', badgeText.length * 6.5 + 10).attr('height', 14)
        .attr('rx', 4).attr('fill', badgeBg);
    badge.append('text').attr('x', 5).attr('y', 11).attr('fill', badgeFg)
        .attr('font-size', '8px').attr('font-weight', '600')
        .attr('font-family', 'Inter, sans-serif').text(badgeText);

    const title = nodeData.title || 'Untitled';
    const maxChars = isRoot ? 28 : 24;
    inner.append('text').attr('x', nodeW / 2).attr('y', 36)
        .attr('text-anchor', 'middle').attr('fill', '#f1f5f9')
        .attr('font-size', isRoot ? '11px' : '10px').attr('font-weight', '500')
        .attr('font-family', 'Inter, sans-serif').style('pointer-events', 'none')
        .text(title.length > maxChars ? title.slice(0, maxChars) + '\u2026' : title);

    let metaStr = '';
    if (nodeData.year) metaStr += nodeData.year;
    if (nodeData.authors && nodeData.authors.length > 0) {
        if (metaStr) metaStr += ' \u00B7 ';
        metaStr += nodeData.authors.slice(0, 2).join(', ');
    }
    if (metaStr.length > 34) metaStr = metaStr.slice(0, 34) + '\u2026';
    inner.append('text').attr('x', nodeW / 2).attr('y', 50)
        .attr('text-anchor', 'middle').attr('fill', '#475569')
        .attr('font-size', '8px').attr('font-family', 'Inter, sans-serif')
        .style('pointer-events', 'none').text(metaStr);

    let st = '', sc = '#475569';
    if (status === 'downloaded') { st = '\u2713 PDF'; sc = '#34d399'; }
    else if (status === 'paywalled') { st = '\uD83D\uDD12 PW'; sc = '#fbbf24'; }
    else if (status === 'not_found') { st = '\u2717 NF'; sc = '#f87171'; }
    else if (status === 'found') { st = '\u25C9'; sc = '#60a5fa'; }
    if (st) {
        inner.append('text').attr('x', 8).attr('y', nodeH - 8)
            .attr('fill', sc).attr('font-size', '8px').attr('font-weight', '600')
            .attr('font-family', 'Inter, sans-serif').style('pointer-events', 'none').text(st);
    }

    if (hasChildren) {
        inner.append('text').attr('x', nodeW - 8).attr('y', nodeH - 8)
            .attr('text-anchor', 'end').attr('fill', '#475569').attr('font-size', '8px')
            .attr('font-family', 'JetBrains Mono, monospace').style('pointer-events', 'none')
            .text(`${nodeData.children.length} refs`);
    }

    d._nw = nodeW;
    d._nh = nodeH;
}

// ─── Semantic Zoom — Visibility & Clusters ───────────────────────────

function onZoomTransform(scale) {
    if (!cachedAllNodes.length || !cachedNodeGroup) return;

    const levelId = getZoomLevel(scale);
    if (levelId === cachedZoomLevelId) return;
    cachedZoomLevelId = levelId;

    const level = getZoomLevelInfo(levelId);
    const maxDepth = level.maxDepth;

    // Update zoom level indicator
    const label = level.label;
    let indicator = treeContainer.querySelector('.zoom-level-indicator');
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.className = 'zoom-level-indicator';
        treeContainer.appendChild(indicator);
    }
    indicator.textContent = label;

    // Show/hide nodes by depth
    cachedNodeGroup.selectAll('g.d3-node-group')
        .style('display', d => (d.depth <= maxDepth) ? null : 'none');

    // Update clusters (donut badges on parents with hidden children)
    cachedNodeGroup.selectAll('g.d3-node-group')
        .each(function(d) {
            const el = d3.select(this);
            if (d.depth > maxDepth) return;
            el.select('.d3-cluster').remove();

            if (d.depth >= maxDepth) {
                const kids = d.data.children || [];
                const hideKids = kids.filter(k => (d.depth + 1) > maxDepth);
                if (hideKids.length === 0) return;

                let dl = 0, pw = 0, nf = 0, fd = 0;
                hideKids.forEach(c => {
                    const s = c.status || 'found';
                    if (s === 'downloaded') dl++; else if (s === 'paywalled') pw++;
                    else if (s === 'not_found') nf++; else fd++;
                });
                const total = hideKids.length;

                const slices = [];
                if (dl > 0) slices.push({ v: dl, c: STATUS_COLORS.downloaded });
                if (pw > 0) slices.push({ v: pw, c: STATUS_COLORS.paywalled });
                if (nf > 0) slices.push({ v: nf, c: STATUS_COLORS.not_found });
                if (fd > 0) slices.push({ v: fd, c: STATUS_COLORS.found });

                const cg = el.append('g').attr('class', 'd3-cluster')
                    .attr('transform', `translate(${d._nw / 2 + 14}, ${-d._nh / 2 + 12})`)
                    .style('cursor', 'pointer')
                    .on('click', function(event) {
                        event.stopPropagation();
                        const svg = d3.select(treeContainer).select('svg');
                        const z = currentZoom;
                        if (svg.node() && z) {
                            svg.transition().duration(400).call(z.scaleBy, 2.2);
                        }
                    });

                const arc = d3.arc().innerRadius(CLUSTER_INNER_R).outerRadius(CLUSTER_OUTER_R);
                let curAngle = -Math.PI / 2;
                slices.forEach(s => {
                    const a = (s.v / total) * 2 * Math.PI;
                    cg.append('path').attr('d', arc({ startAngle: curAngle, endAngle: curAngle + a }))
                        .attr('fill', s.c).attr('stroke', 'rgba(6,10,13,0.6)').attr('stroke-width', 1);
                    curAngle += a;
                });
                if (slices.length === 0) {
                    cg.append('circle').attr('r', CLUSTER_OUTER_R)
                        .attr('fill', 'none').attr('stroke', 'rgba(255,255,255,0.1)').attr('stroke-width', 2);
                }

                cg.append('text').attr('text-anchor', 'middle').attr('dy', '0.35em')
                    .attr('fill', '#f1f5f9').attr('font-size', '10px').attr('font-weight', '700')
                    .attr('font-family', 'JetBrains Mono, monospace').text(total);
            }
        });

    // Dim links to/from hidden nodes
    if (cachedLinkGroup) {
        cachedLinkGroup.selectAll('path')
            .style('opacity', d => {
                const s = d.source.depth, t = d.target.depth;
                return (s <= maxDepth && t <= maxDepth) ? 1 : 0.06;
            });
    }
}

// ─── PDF Viewer (Chrome-style) ──────────────────────────────────────

let pdfBaseScale = 1.0;
let pdfCurrentScalePercent = 100;

function openPdfViewer(folder, filename, title) {
    if (!folder || !filename) return;
    pdfTitle.textContent = title;
    currentPdfUrl = `/api/pdf/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`;
    pdfCurrentScalePercent = 100;
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
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        await calculateBaseScale();
        await renderAllPages();
    } catch (err) {
        pdfPages.innerHTML = '<div class="pdf-loading">Failed to load PDF</div>';
    }
}

async function calculateBaseScale() {
    if (!pdfDoc) return;
    const p = await pdfDoc.getPage(1);
    const viewport = p.getViewport({ scale: 1.0 });
    const w = pdfBody.clientWidth || (window.innerWidth - 40);
    pdfBaseScale = (w - 80) / viewport.width;
    pdfCurrentScalePercent = 100;
    pdfZoomLevel.textContent = '100%';
}

function getPdfScale() {
    return pdfBaseScale * (pdfCurrentScalePercent / 100);
}

async function renderAllPages() {
    if (!pdfDoc) return;
    pdfPages.innerHTML = '';
    pdfPagesData = [];

    const scale = getPdfScale();
    const firstPage = await pdfDoc.getPage(1);
    const viewport = firstPage.getViewport({ scale: 1.0 });
    const pageWidth = viewport.width * scale;
    const pageHeight = viewport.height * scale;

    for (let i = 1; i <= pdfDoc.numPages; i++) {
        const pageContainer = document.createElement('div');
        pageContainer.className = 'pdf-page-container';
        pageContainer.dataset.page = i;
        pageContainer.style.width = `${pageWidth}px`;
        pageContainer.style.height = `${pageHeight}px`;
        pdfPages.appendChild(pageContainer);
    }

    const batchSize = 6;
    for (let i = 1; i <= pdfDoc.numPages; i += batchSize) {
        const batch = [];
        for (let j = i; j < Math.min(i + batchSize, pdfDoc.numPages + 1); j++) {
            batch.push(renderPage(j));
        }
        await Promise.all(batch);
        await new Promise(r => setTimeout(r, 5));
    }

    updateVisiblePage();
}

async function renderPage(pageNum) {
    try {
        const page = await pdfDoc.getPage(pageNum);
        const scale = getPdfScale();
        const viewport = page.getViewport({ scale });

        const container = pdfPages.querySelector(`[data-page="${pageNum}"]`);
        if (!container) return;

        const existingCanvas = container.querySelector('canvas');
        if (existingCanvas) existingCanvas.remove();

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

    const scale = getPdfScale();
    const firstPage = await pdfDoc.getPage(1);
    const viewport = firstPage.getViewport({ scale: 1.0 });
    const pageWidth = viewport.width * scale;
    const pageHeight = viewport.height * scale;

    pdfPages.innerHTML = '';
    pdfPagesData = [];

    for (let i = 1; i <= pdfDoc.numPages; i++) {
        const container = document.createElement('div');
        container.className = 'pdf-page-container';
        container.dataset.page = i;
        container.style.width = `${pageWidth}px`;
        container.style.height = `${pageHeight}px`;
        pdfPages.appendChild(container);
    }

    const batchSize = 6;
    for (let i = 1; i <= pdfDoc.numPages; i += batchSize) {
        const batch = [];
        for (let j = i; j < Math.min(i + batchSize, pdfDoc.numPages + 1); j++) {
            batch.push(renderPage(j));
        }
        await Promise.all(batch);
        await new Promise(r => setTimeout(r, 5));
    }

    updateVisiblePage();
}

// ─── Zoom ────────────────────────────────────────────────────────────
function zoomIn() {
    if (pdfCurrentScalePercent >= 300) return;
    pdfCurrentScalePercent = Math.min(300, pdfCurrentScalePercent + 25);
    pdfZoomLevel.textContent = `${pdfCurrentScalePercent}%`;
    reRenderAllPages();
}

function zoomOut() {
    if (pdfCurrentScalePercent <= 25) return;
    pdfCurrentScalePercent = Math.max(25, pdfCurrentScalePercent - 25);
    pdfZoomLevel.textContent = `${pdfCurrentScalePercent}%`;
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
        svg.transition().duration(300).call(zoom.scaleBy, 1.4);
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
        svg.transition().duration(500)
            .call(zoom.transform, d3.zoomIdentity
                .translate(cachedCenterX, cachedCenterY)
                .scale(0.7)
                .translate(-cachedCenterX, -cachedCenterY));
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
        svg.transition().duration(300).call(zoom.scaleBy, 1.4);
    }
    if (e.key === '-') {
        e.preventDefault();
        svg.transition().duration(300).call(zoom.scaleBy, 0.7);
    }
    if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        svg.transition().duration(500)
            .call(zoom.transform, d3.zoomIdentity
                .translate(cachedCenterX, cachedCenterY)
                .scale(0.7)
                .translate(-cachedCenterX, -cachedCenterY));
    }
});

// ─── Window Resize Handler ───────────────────────────────────────────
let resizeTimeout = null;
window.addEventListener('resize', () => {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(async () => {
        if (treeScreen.classList.contains('active') && currentTreeData) {
            renderTree(currentTreeData);
        }
        if (pdfOverlay.classList.contains('active') && pdfDoc) {
            await calculateBaseScale();
            await reRenderAllPages();
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
