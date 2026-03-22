/* ═══════════════════════════════════════════════════════════════════════════
   Aesthetics Map — app.js
   Pixi.js v7 visualization with 3-level zoom hierarchy
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── Constants ────────────────────────────────────────────────────────────────

const WORLD_SCALE   = 2200;   // node coords [-1,1] → world pixels
const NODE_BASE_R   = 3;      // min node radius (world px)
const NODE_MAX_R    = 11;     // max node radius (world px)
const EDGE_ALPHA    = 0.07;   // base edge opacity
const GLITTER_COUNT = 180;

// Zoom scale thresholds (world→screen transform scale)
const ZOOM = { L1: 0.15, L2: 0.28, NODES: 0.85 };
// L1 labels: scale 0.15 → 0.28
// L2 labels: scale 0.28 → 2.2  (wide window — readable from mid-zoom all the way in)
// Node names: scale 0.85 →  ∞  (overlaps with L2 intentionally)

// Vaporwave-dreamcore palette (per L1 community index)
const PALETTE = [
  0xff6eb4, 0xc77dff, 0xe879f9, 0x818cf8,
  0xff9de2, 0xa78bfa, 0xf0abfc, 0x67e8f9,
  0xfbbf24, 0xfb7185, 0x34d399, 0xa5b4fc,
  0xff80ab, 0xd8b4fe, 0x93c5fd, 0xfca5a5,
  0x6ee7b7, 0xfde68a, 0xc4b5fd, 0xf9a8d4,
];

const LABEL_STYLES = {
  l1:   { fontFamily: 'Cormorant Garamond', fontSize: 28, fontWeight: '600',
          fill: 0xffffff, alpha: 0.82 },
  l2:   { fontFamily: 'Quicksand', fontSize: 14, fontWeight: '600',
          alpha: 0.72 },         // fill set per-label from community color
  node: { fontFamily: 'Quicksand', fontSize: 9, fontWeight: '500',
          fill: 0xffffff, alpha: 0.55 },
};

// ── State ────────────────────────────────────────────────────────────────────

let app, world, densityLayer, edgeGfx, nodeLayer, labelLayer, glitterLayer;
let nodesData = [], commMap = {};
let nodeObjects = [];   // {id, worldX, worldY, gfx, data, color}
let nodeColorMap = {};  // nodeId → pixi hex color
let nodeCommMap  = {};  // nodeId → l1 community id
let vpScale = 0.18, vpX = 0, vpY = 0;
let isDragging = false, dragStartX = 0, dragStartY = 0, startVpX = 0, startVpY = 0;
let hoveredNode = null, selectedNode = null;
let flyTarget = null;   // {x, y, scale} for animated fly-to
let hintTimer;

// ── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  setLoadProgress(10);

  // Pixi app
  app = new PIXI.Application({
    width:           window.innerWidth,
    height:          window.innerHeight,
    backgroundColor: 0x16161d,
    antialias:       true,
    resolution:      Math.min(window.devicePixelRatio || 1, 2),
    autoDensity:     true,
  });
  app.view.id = 'pixi-canvas';
  document.body.appendChild(app.view);

  // Load data
  setLoadProgress(20);
  const [nodesJson, edgesJson] = await Promise.all([
    fetch('nodes.json').then(r => r.json()),
    fetch('edges.json').then(r => r.json()),
  ]);
  setLoadProgress(60);

  nodesData = nodesJson.nodes;
  const communities = nodesJson.communities;
  const edges       = edgesJson.edges;

  // Build community lookup
  communities.forEach(c => { commMap[c.id] = c; });

  // Assign palette color per L1 community (by rank = insertion order)
  const l1ids = communities.filter(c => c.level === 1)
                            .sort((a, b) => b.size - a.size)
                            .map(c => c.id);
  const l1ColorMap = {};
  l1ids.forEach((id, i) => { l1ColorMap[id] = PALETTE[i % PALETTE.length]; });

  // Each node inherits its L1 ancestor's color (module-level so openPanel can use it)
  nodesData.forEach(n => {
    nodeColorMap[n.id] = l1ColorMap[n.c1] ?? 0xc77dff;
    nodeCommMap[n.id]  = n.c1;
  });

  setLoadProgress(70);

  // Build scene layers
  world        = new PIXI.Container();
  densityLayer = new PIXI.Container();
  edgeGfx      = new PIXI.Graphics();
  nodeLayer    = new PIXI.Container();
  glitterLayer = new PIXI.Container();
  labelLayer   = new PIXI.Container();

  world.addChild(densityLayer);
  world.addChild(edgeGfx);
  world.addChild(nodeLayer);
  world.addChild(glitterLayer);
  world.addChild(labelLayer);
  app.stage.addChild(world);

  // ── Density heatmap — pre-baked to a static texture (zero per-frame cost) ──
  // Draw all halos into a temporary Graphics, blur once, bake into RenderTexture,
  // then display as a plain Sprite. No filter runs after startup.
  const densityGfx = new PIXI.Graphics();
  nodesData.forEach(n => {
    const r   = NODE_BASE_R + (NODE_MAX_R - NODE_BASE_R) * Math.sqrt(n.degree_norm);
    const col = nodeColorMap[n.id];
    // Wide soft halo (territory colour)
    densityGfx.beginFill(col, 0.038);
    densityGfx.drawCircle(n.x * WORLD_SCALE, n.y * WORLD_SCALE, r * 22);
    densityGfx.endFill();
    // Tighter inner glow (cluster core brightness)
    densityGfx.beginFill(col, 0.12);
    densityGfx.drawCircle(n.x * WORLD_SCALE, n.y * WORLD_SCALE, r * 7);
    densityGfx.endFill();
  });
  densityGfx.filters = [new PIXI.filters.BlurFilter(48, 2)];

  // Bake to texture at 25% resolution — plenty for a blurry background
  const lb      = densityGfx.getLocalBounds();
  const BAKE_RES = 0.25;
  const bakeW   = Math.max(Math.ceil(lb.width  * BAKE_RES), 1);
  const bakeH   = Math.max(Math.ceil(lb.height * BAKE_RES), 1);
  const rt      = PIXI.RenderTexture.create({ width: bakeW, height: bakeH });
  const bakeMatrix = new PIXI.Matrix()
    .translate(-lb.x, -lb.y)
    .scale(BAKE_RES, BAKE_RES);
  app.renderer.render(densityGfx, { renderTexture: rt, transform: bakeMatrix, clear: true });

  const densitySprite = new PIXI.Sprite(rt);
  densitySprite.position.set(lb.x, lb.y);
  densitySprite.scale.set(1 / BAKE_RES);
  densityLayer.addChild(densitySprite);
  // Filter no longer needed on live display object
  densityGfx.filters = null;

  // ── Edges ──
  const edgeSet = new Set();
  edges.forEach(e => {
    const src = nodesData.find(n => n.id === e.source);
    const tgt = nodesData.find(n => n.id === e.target);
    if (!src || !tgt) return;
    const key = [e.source, e.target].sort().join('||');
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    const col = nodeColorMap[e.source] ?? 0xc77dff;
    const alpha = Math.min(EDGE_ALPHA * e.weight, 0.18);
    edgeGfx.lineStyle(0.8, col, alpha);
    edgeGfx.moveTo(src.x * WORLD_SCALE, src.y * WORLD_SCALE);
    edgeGfx.lineTo(tgt.x * WORLD_SCALE, tgt.y * WORLD_SCALE);
  });

  setLoadProgress(80);

  // ── Nodes ──
  // Sort descending by degree so large nodes are added first (bottom of stack).
  // Pixi hit-tests from top → bottom, so small nodes added last get priority
  // when nodes overlap — making every node individually selectable.
  const sortedNodes = [...nodesData].sort((a, b) => b.degree_norm - a.degree_norm);
  sortedNodes.forEach(n => {
    const wx   = n.x * WORLD_SCALE;
    const wy   = n.y * WORLD_SCALE;
    const r    = NODE_BASE_R + (NODE_MAX_R - NODE_BASE_R) * Math.sqrt(n.degree_norm);
    const col  = nodeColorMap[n.id];

    const gfx = new PIXI.Graphics();
    drawNode(gfx, r, col, false);
    gfx.position.set(wx, wy);
    gfx.eventMode = 'static';
    gfx.cursor = 'pointer';
    // Hit area = visual radius only, so a nearby small node isn't blocked
    gfx.hitArea = new PIXI.Circle(0, 0, Math.max(r, 5));

    gfx.on('pointerover', () => onNodeHover(n, gfx, r, col));
    gfx.on('pointerout',  () => onNodeUnhover(n, gfx, r, col));
    gfx.on('pointertap',  () => onNodeClick(n));

    nodeLayer.addChild(gfx);
    nodeObjects.push({ id: n.id, wx, wy, gfx, data: n, color: col, radius: r });
  });

  // ── Labels ──
  buildLabels(communities);

  // ── Glitter ──
  buildGlitter();

  setLoadProgress(95);

  // ── Initial viewport ──
  fitViewport();

  // ── Event listeners ──
  bindViewportEvents();
  bindSearchEvents();
  bindPanelEvents();

  // ── Ticker ──
  app.ticker.add(onTick);

  // ── Resize ──
  window.addEventListener('resize', () => {
    app.renderer.resize(window.innerWidth, window.innerHeight);
    fitViewport();
    updateTransform();
  });

  setLoadProgress(100);
  setTimeout(hideLoading, 400);

  // Hide hint after first interaction
  hintTimer = setTimeout(() => document.getElementById('hint').classList.add('hidden'), 6000);
}

// ── Node drawing ─────────────────────────────────────────────────────────────

function drawNode(gfx, r, col, hovered) {
  gfx.clear();
  // Always-on ambient glow (soft, outside visual radius)
  gfx.beginFill(col, 0.08);
  gfx.drawCircle(0, 0, r * 2.8);
  gfx.endFill();
  gfx.beginFill(col, 0.14);
  gfx.drawCircle(0, 0, r * 1.7);
  gfx.endFill();

  if (hovered) {
    // Extra bright rings on hover
    gfx.beginFill(col, 0.28);
    gfx.drawCircle(0, 0, r * 3.8);
    gfx.endFill();
    gfx.beginFill(col, 0.45);
    gfx.drawCircle(0, 0, r * 2.2);
    gfx.endFill();
  }

  // Main filled circle
  gfx.beginFill(col, hovered ? 1.0 : 0.88);
  gfx.drawCircle(0, 0, r);
  gfx.endFill();

  // Specular highlight
  gfx.beginFill(0xffffff, hovered ? 0.55 : 0.30);
  gfx.drawCircle(-r * 0.28, -r * 0.28, r * 0.38);
  gfx.endFill();
}

// ── Labels ───────────────────────────────────────────────────────────────────

function buildLabels(communities) {
  // L1 community labels — large serif, always white
  communities.filter(c => c.level === 1 && c.size >= 8).forEach(c => {
    const s = LABEL_STYLES.l1;
    const text = new PIXI.Text(c.labels[0], {
      fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight,
      fill: s.fill, align: 'center',
      dropShadow: true, dropShadowColor: 0x000000,
      dropShadowAlpha: 0.7, dropShadowDistance: 3,
    });
    text.anchor.set(0.5, 0.5);
    text.position.set(c.cx * WORLD_SCALE, c.cy * WORLD_SCALE);
    text.alpha = 0;
    text._level    = 1;
    text._minScale = ZOOM.L1;
    text._maxScale = ZOOM.L2;
    text._targetAlpha = s.alpha;
    labelLayer.addChild(text);
  });

  // L2 community labels — colored by their L1 parent community
  communities.filter(c => c.level === 2 && c.size >= 4).forEach(c => {
    const parentColor = (() => {
      // walk up to L1 parent
      const parent = commMap[c.parent];
      if (!parent) return 0xe0aaff;
      const l1 = parent.level === 1 ? parent : commMap[parent.parent];
      if (!l1) return 0xe0aaff;
      const rank = communities.filter(x => x.level === 1)
                              .sort((a, b) => b.size - a.size)
                              .findIndex(x => x.id === l1.id);
      return PALETTE[rank >= 0 ? rank % PALETTE.length : 0];
    })();

    const s = LABEL_STYLES.l2;
    const text = new PIXI.Text(c.labels[0], {
      fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight,
      fill: parentColor, align: 'center',
      dropShadow: true, dropShadowColor: 0x000000,
      dropShadowAlpha: 0.8, dropShadowDistance: 2,
    });
    text.anchor.set(0.5, 0.5);
    text.position.set(c.cx * WORLD_SCALE, c.cy * WORLD_SCALE);
    text.alpha = 0;
    text._level    = 2;
    text._minScale = ZOOM.L2;
    text._maxScale = Infinity;
    text._targetAlpha = s.alpha;
    labelLayer.addChild(text);
  });

  // Node name labels — shown from ZOOM.NODES onward
  nodesData.forEach(n => {
    const r = NODE_BASE_R + (NODE_MAX_R - NODE_BASE_R) * Math.sqrt(n.degree_norm);
    const text = new PIXI.Text(n.id, {
      fontFamily: 'Quicksand', fontSize: 13, fontWeight: '600',
      fill: 0xffffff, align: 'center',
      dropShadow: true, dropShadowColor: 0x000000,
      dropShadowAlpha: 0.9, dropShadowDistance: 1,
    });
    text.anchor.set(0.5, 0);
    text.position.set(n.x * WORLD_SCALE, n.y * WORLD_SCALE + r + 3);
    text.alpha = 0;
    text._level    = 3;
    text._minScale = ZOOM.NODES;
    text._maxScale = Infinity;
    text._targetAlpha = LABEL_STYLES.node.alpha;
    labelLayer.addChild(text);
  });
}

// ── Glitter ───────────────────────────────────────────────────────────────────

function buildGlitter() {
  for (let i = 0; i < GLITTER_COUNT; i++) {
    // Bias position toward where nodes are dense
    const ref = nodesData[Math.floor(Math.random() * nodesData.length)];
    const wx  = ref.x * WORLD_SCALE + (Math.random() - 0.5) * 600;
    const wy  = ref.y * WORLD_SCALE + (Math.random() - 0.5) * 600;

    const gfx = new PIXI.Graphics();
    const sz  = Math.random() * 1.8 + 0.5;
    gfx.beginFill(0xffffff, 1);
    gfx.drawCircle(0, 0, sz);
    gfx.endFill();
    gfx.position.set(wx, wy);
    gfx.alpha = Math.random() * 0.5 + 0.1;
    gfx._phase  = Math.random() * Math.PI * 2;
    gfx._speed  = Math.random() * 0.4 + 0.2;
    gfx._drift  = { x: (Math.random() - 0.5) * 0.08, y: (Math.random() - 0.5) * 0.06 };
    glitterLayer.addChild(gfx);
  }
}

// ── Viewport ─────────────────────────────────────────────────────────────────

function fitViewport() {
  const W = app.renderer.width  / app.renderer.resolution;
  const H = app.renderer.height / app.renderer.resolution;
  vpScale = Math.min(W, H) / (WORLD_SCALE * 2.2);
  vpX = W / 2;
  vpY = H / 2;
}

function updateTransform() {
  world.scale.set(vpScale);
  world.position.set(vpX, vpY);
  updateLOD();
}

function updateLOD() {
  const s = vpScale;
  const inv = 1 / Math.max(s, 0.01);
  labelLayer.children.forEach(lbl => {
    if (lbl._level === undefined) return;
    const inRange = s >= lbl._minScale && s < lbl._maxScale;
    const target  = inRange ? (lbl._targetAlpha ?? 0.6) : 0;
    lbl.alpha  += (target - lbl.alpha) * 0.12;
    lbl.visible = lbl.alpha > 0.005;
    lbl.scale.set(inv);  // keep text screen-size-constant regardless of zoom
  });
}

// ── Viewport events ───────────────────────────────────────────────────────────

function bindViewportEvents() {
  const canvas = app.view;

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    clearFly();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const mx = e.clientX, my = e.clientY;
    vpX = mx - (mx - vpX) * factor;
    vpY = my - (my - vpY) * factor;
    vpScale = Math.max(0.04, Math.min(vpScale * factor, 30));
    updateTransform();
    hideHint();
  }, { passive: false });

  canvas.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    isDragging = true;
    dragStartX = e.clientX; dragStartY = e.clientY;
    startVpX = vpX; startVpY = vpY;
    clearFly();
    hideHint();
  });

  window.addEventListener('mousemove', e => {
    if (!isDragging) return;
    vpX = startVpX + (e.clientX - dragStartX);
    vpY = startVpY + (e.clientY - dragStartY);
    updateTransform();
  });

  window.addEventListener('mouseup', () => { isDragging = false; });

  // Touch pinch
  let lastDist = 0;
  canvas.addEventListener('touchstart', e => {
    hideHint();
    if (e.touches.length === 2) {
      lastDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    }
  }, { passive: true });

  canvas.addEventListener('touchmove', e => {
    if (e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const factor = dist / lastDist;
      const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      vpX = cx - (cx - vpX) * factor;
      vpY = cy - (cy - vpY) * factor;
      vpScale = Math.max(0.04, Math.min(vpScale * factor, 30));
      lastDist = dist;
      updateTransform();
    }
  }, { passive: true });
}

// ── Fly-to animation ──────────────────────────────────────────────────────────

function flyTo(worldX, worldY, targetScale) {
  flyTarget = { x: worldX, y: worldY, scale: targetScale };
}

function clearFly() { flyTarget = null; }

// ── Node interaction ──────────────────────────────────────────────────────────

function onNodeHover(n, gfx, r, col) {
  hoveredNode = n.id;
  drawNode(gfx, r, col, true);
  showTooltip(n.id, gfx);
}

function onNodeUnhover(n, gfx, r, col) {
  hoveredNode = null;
  if (selectedNode !== n.id) drawNode(gfx, r, col, false);
  hideTooltip();
}

function onNodeClick(n) {
  // Un-highlight previous selection
  if (selectedNode && selectedNode !== n.id) {
    const prev = nodeObjects.find(o => o.id === selectedNode);
    if (prev) drawNode(prev.gfx, prev.radius, prev.color, false);
  }
  selectedNode = n.id;
  openPanel(n);
  flyTo(n.x * WORLD_SCALE, n.y * WORLD_SCALE, Math.max(vpScale, ZOOM.NODES));
}

// ── Tooltip ───────────────────────────────────────────────────────────────────

function showTooltip(text, gfx) {
  const tt = document.getElementById('tooltip');
  tt.textContent = text;
  tt.classList.add('visible');

  // Position based on gfx world → screen
  const wp = gfx.getGlobalPosition();
  tt.style.left = `${wp.x}px`;
  tt.style.top  = `${wp.y}px`;
}

function hideTooltip() {
  document.getElementById('tooltip').classList.remove('visible');
}

// ── Side panel ────────────────────────────────────────────────────────────────

function openPanel(n) {
  const d = n.info || {};
  const panel = document.getElementById('panel');
  const content = document.getElementById('panel-content');

  // Cover image
  let html = '';
  if (n.image_url) {
    html += `<div class="panel-cover">
      <img src="${escAttr(n.image_url)}" alt="${escAttr(n.id)}" loading="lazy" />
    </div>`;
  }

  // Title
  html += `<h2 class="panel-title">${escHtml(n.id)}</h2>`;

  // Categories as pills
  if (n.categories?.length) {
    html += `<div class="panel-cats">`;
    n.categories.slice(0, 8).forEach(c => {
      html += `<span class="panel-cat">${escHtml(c)}</span>`;
    });
    html += `</div>`;
  }

  html += `<div class="panel-divider"></div>`;

  // Quick-facts grid
  const facts = [
    ['Decade',   d.decade_of_origin],
    ['Origin',   d.location_of_origin],
    ['Creators', d.creators || d.coined_by],
    ['Platform', d.primary_platform],
    ['Colours',  d.key_colours],
    ['Motifs',   d.key_motifs],
    ['Values',   d.key_values],
  ].filter(([, v]) => v);

  facts.forEach(([label, val]) => {
    html += `<div class="panel-field">
      <div class="panel-field-label">${label}</div>
      <div class="panel-field-value">${escHtml(val)}</div>
    </div>`;
  });

  // Related aesthetics as clickable chips colored by their community
  const related = parseList(d.related_aesthetics || d.relatedaesthetics);
  if (related.length) {
    html += `<div class="panel-field">
      <div class="panel-field-label">Related Aesthetics</div>
      <div class="panel-chips">`;
    related.slice(0, 20).forEach(name => {
      html += coloredChip(name);
    });
    html += `</div></div>`;
  }

  // Subgenres
  const subs = parseList(d.subgenres);
  if (subs.length) {
    html += `<div class="panel-field">
      <div class="panel-field-label">Subgenres</div>
      <div class="panel-chips">`;
    subs.forEach(name => { html += coloredChip(name); });
    html += `</div></div>`;
  }

  // Media & brands
  const media  = parseList(d.related_media);
  const brands = parseList(d.related_brands);
  const icons  = parseList(d.iconic_figures);
  if (media.length) {
    html += `<div class="panel-field"><div class="panel-field-label">Related Media</div>
      <div class="panel-field-value">${media.map(escHtml).join(', ')}</div></div>`;
  }
  if (brands.length) {
    html += `<div class="panel-field"><div class="panel-field-label">Related Brands</div>
      <div class="panel-field-value">${brands.map(escHtml).join(', ')}</div></div>`;
  }
  if (icons.length) {
    html += `<div class="panel-field"><div class="panel-field-label">Iconic Figures</div>
      <div class="panel-field-value">${icons.map(escHtml).join(', ')}</div></div>`;
  }

  html += `<div class="panel-divider"></div>`;
  html += `<a class="panel-wiki-link" href="${escAttr(n.url)}" target="_blank" rel="noopener">
    ↗ Open on Aesthetics Wiki
  </a>`;

  content.innerHTML = html;
  content.scrollTop = 0;
  panel.classList.add('open');

  // Chip click → fly-to
  content.querySelectorAll('.panel-chip[data-fly]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.fly;
      const obj = nodeObjects.find(o => o.id === target);
      if (obj) {
        flyTo(obj.wx, obj.wy, Math.max(vpScale, ZOOM.NODES));
        openPanel(obj.data);
      }
    });
  });
}

function closePanel() {
  document.getElementById('panel').classList.remove('open');
  if (selectedNode) {
    const prev = nodeObjects.find(o => o.id === selectedNode);
    if (prev) drawNode(prev.gfx, prev.radius, prev.color, false);
  }
  selectedNode = null;
}

function bindPanelEvents() {
  document.getElementById('panel-close').addEventListener('click', closePanel);
}

// ── Search ────────────────────────────────────────────────────────────────────

function bindSearchEvents() {
  const input   = document.getElementById('search');
  const results = document.getElementById('search-results');
  const titles  = nodesData.map(n => n.id);

  let activeIdx = -1;

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    results.innerHTML = '';
    activeIdx = -1;
    if (!q) { results.classList.remove('visible'); return; }

    const matches = titles.filter(t => t.toLowerCase().includes(q)).slice(0, 30);
    if (!matches.length) { results.classList.remove('visible'); return; }

    matches.forEach((title, i) => {
      const div = document.createElement('div');
      div.className = 'search-result';
      div.innerHTML = title.replace(new RegExp(`(${escRegex(q)})`, 'gi'), '<em>$1</em>');
      div.addEventListener('click', () => selectSearchResult(title));
      results.appendChild(div);
    });
    results.classList.add('visible');
  });

  input.addEventListener('keydown', e => {
    const items = results.querySelectorAll('.search-result');
    if (e.key === 'ArrowDown') {
      activeIdx = Math.min(activeIdx + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
    } else if (e.key === 'ArrowUp') {
      activeIdx = Math.max(activeIdx - 1, 0);
      items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
    } else if (e.key === 'Enter') {
      if (activeIdx >= 0) items[activeIdx]?.click();
      else if (items.length === 1) items[0].click();
    } else if (e.key === 'Escape') {
      input.value = '';
      results.classList.remove('visible');
    }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('#search-wrap')) results.classList.remove('visible');
  });
}

function selectSearchResult(title) {
  const obj = nodeObjects.find(o => o.id === title);
  if (!obj) return;
  document.getElementById('search').value = '';
  document.getElementById('search-results').classList.remove('visible');
  flyTo(obj.wx, obj.wy, Math.max(vpScale, ZOOM.NODES));
  openPanel(obj.data);
}

// ── Ticker ────────────────────────────────────────────────────────────────────

function onTick(delta) {
  // Fly-to animation
  if (flyTarget) {
    const W = app.renderer.width  / app.renderer.resolution;
    const H = app.renderer.height / app.renderer.resolution;
    const targetVpX = W / 2 - flyTarget.x * flyTarget.scale;
    const targetVpY = H / 2 - flyTarget.y * flyTarget.scale;
    vpX     += (targetVpX     - vpX)     * 0.08;
    vpY     += (targetVpY     - vpY)     * 0.08;
    vpScale += (flyTarget.scale - vpScale) * 0.08;
    updateTransform();
    if (Math.abs(vpX - targetVpX) < 0.5 &&
        Math.abs(vpY - targetVpY) < 0.5 &&
        Math.abs(vpScale - flyTarget.scale) < 0.001) {
      flyTarget = null;
    }
  }

  // Glitter animation
  const t = performance.now() * 0.001;
  glitterLayer.children.forEach(g => {
    g.alpha = 0.12 + 0.25 * (0.5 + 0.5 * Math.sin(t * g._speed + g._phase));
    g.x += g._drift.x;
    g.y += g._drift.y;
    // Wrap within bounds
    const bound = WORLD_SCALE * 1.1;
    if (g.x > bound)  g.x = -bound;
    if (g.x < -bound) g.x = bound;
    if (g.y > bound)  g.y = -bound;
    if (g.y < -bound) g.y = bound;
  });

  // LOD smooth fade
  updateLOD();
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function setLoadProgress(pct) {
  const fill = document.getElementById('loading-fill');
  if (fill) fill.style.width = pct + '%';
}

function hideLoading() {
  const el = document.getElementById('loading');
  el.classList.add('fade-out');
  setTimeout(() => el.remove(), 900);
}

function hideHint() {
  clearTimeout(hintTimer);
  document.getElementById('hint').classList.add('hidden');
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
                         .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s) { return escHtml(s); }
function escRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function parseList(val) {
  if (!val) return [];
  return val.split(/[;,]+/).map(s => s.trim()).filter(Boolean);
}

function pixiToCSS(hex) {
  return '#' + (hex >>> 0).toString(16).padStart(6, '0');
}

// Build a chip button for an aesthetic name, colored by its community
function coloredChip(name) {
  const hex = nodeColorMap[name];
  if (!hex) {
    return `<button class="panel-chip" data-fly="${escAttr(name)}">${escHtml(name)}</button>`;
  }
  const css = pixiToCSS(hex);
  return `<button class="panel-chip" data-fly="${escAttr(name)}"
    style="border-color:${css}55;color:${css};background:${css}18;"
  >${escHtml(name)}</button>`;
}

// ── Start ─────────────────────────────────────────────────────────────────────

boot().catch(err => {
  console.error('Boot failed:', err);
  document.getElementById('loading').innerHTML =
    `<div class="loading-inner"><p style="color:#ff6eb4">Failed to load: ${err.message}</p></div>`;
});
