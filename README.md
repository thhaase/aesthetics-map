# Aesthetics Map

An interactive network visualization of the [Aesthetics Wiki](https://aesthetics.fandom.com/wiki/List_of_Aesthetics) — 1,031 aesthetic pages mapped by their relationships and textual similarity, rendered as an explorable landscape.

Inspired by [bluesky-map.theo.io](https://bluesky-map.theo.io/).

**Live:** [thhaase.github.io/aesthetics-map](https://thhaase.github.io/aesthetics-map)

---

## How to use

| Action | Result |
|---|---|
| Scroll | Zoom in / out |
| Drag | Pan |
| Click a node | Open side panel with full article info |
| Click a chip in the panel | Fly camera to that aesthetic |
| Search bar | Find any aesthetic by name |

Labels appear in layers as you zoom: broad cluster names first, then subcategory names, then individual node names at the closest zoom.

---

## Data

Scraped from the Aesthetics Wiki via the MediaWiki API (`scraper.R`). Each page becomes one node. The scraper collects:

- Full article text
- Infobox fields: related aesthetics, subgenres, overlaps with, decade of origin, location, key motifs, key colours, key values, creators, platform, related media, brands, iconic figures
- Wiki categories
- Cover image URL (via `fetch_images.py`, `pageimages` API)

**1,031 pages** across 27 columns. 1,013 have a cover image.

### Data quality notes

The scraper produced two sets of connection columns due to an infobox label-mapping mismatch. The raw (unsanitized) column names contain the actual data:

| Intended column | Actual column with data |
|---|---|
| `related_aesthetics` | `relatedaesthetics` (987 / 1031 filled) |
| `overlaps_with` | `overlapswith` (77 / 1031 filled) |

Use `relatedaesthetics` as the primary edge source.

---

## Nodes

Each node is one aesthetic page. Visual properties:

- **Size** — proportional to `sqrt(weighted degree)`, i.e. how many connections the aesthetic has (and how strongly weighted). Ranges from 3 to 11 world-pixels.
- **Color** — inherited from the node's Level-1 community, assigned from a fixed vaporwave palette (pink → purple → lavender → cyan family). All nodes in the same broad cluster share a hue.
- **Glow** — an ambient soft-glow ring is always visible; it intensifies on hover.

---

## Edges

Edges are drawn between pages that reference each other via infobox connection fields. Three types, with different weights:

| Field | Relationship | Weight |
|---|---|---|
| `relatedaesthetics` | General similarity / association | 1.0 |
| `overlapswith` | Explicit stated overlap | 1.2 |
| `subgenres` | Hierarchical parent → child | 1.5 |

When two pages mutually list each other (A lists B and B lists A), the weights accumulate — so bidirectional links are stronger. The final edge weight is the sum across all connection types between a pair.

**5,307 edges** total. 28 pages (2.7%) have no connections and appear as a ring of isolated nodes around the periphery.

---

## Layout algorithm

Position on the canvas encodes **semantic + topological similarity**: aesthetics that are conceptually close and/or connected appear near each other.

### Step 1 — Build the distance matrix

Two complementary distance signals are computed for all 1,031 × 1,031 pairs:

**Graph distance (55% weight)**
- Edge weights are converted to distances: `d = 1 / weight`
- All-pairs shortest-path distances are computed via Dijkstra
- Disconnected pairs are assigned distance 1.0 (maximum)
- Result is normalised to [0, 1]

**Text distance (45% weight)**
- Article text is concatenated with wiki categories, key motifs, key colours, and key values for each page
- TF-IDF vectors are computed (8,000 features, bigrams, log sublinear TF, min-df 2)
- Pairwise cosine distance between TF-IDF vectors gives the semantic signal

The final distance is a weighted blend:
```
dist(i, j) = 0.55 × graph_dist(i, j) + 0.45 × text_dist(i, j)
```

This means two aesthetics will be placed near each other if they **either** link to each other in their infoboxes **or** describe themselves in similar language — even if they never explicitly mention each other.

### Step 2 — UMAP projection

[UMAP](https://umap-learn.readthedocs.io/) is run on the precomputed distance matrix:

```
n_neighbors = 18
min_dist    = 0.25
spread      = 1.2
n_epochs    = 500
metric      = 'precomputed'
```

UMAP preserves both local structure (nearest neighbours stay near each other) and global structure (broad cluster relationships), making it well-suited for this combined distance.

### Step 3 — Normalisation

Positions are normalised using the 95th-percentile spread of the 1,003 connected nodes, so moderate outliers don't compress the core. The 28 isolated nodes are placed on a ring at radius 1.45 (just outside the main cluster) rather than at UMAP-assigned positions.

---

## Community detection and labels

Clusters are found with the [Louvain algorithm](https://python-louvain.readthedocs.io/) run at two levels of resolution.

### Level 1 (broad clusters)

Louvain is run on the full weighted graph at resolution 1.0. This produces ~11 large meaningful clusters (size ≥ 8) plus ~28 singleton communities for the isolated nodes.

### Level 2 (subclusters)

For each Level-1 cluster, Louvain is run again on the induced subgraph at resolution 1.3, producing finer subdivisions.

### Labelling with cluster-level TF-IDF

Cluster labels are chosen to be **distinctive**, not just frequent. The naive approach (most common category per cluster) produces generic labels like "Internet Aesthetics" on many clusters simultaneously. Instead:

Each cluster is treated as a *document* whose terms are the wiki category tags of all its member pages. TF-IDF is computed across all clusters at the same level:

```
TF(term, cluster)  = frequency of term in cluster / total terms in cluster
IDF(term)          = log(N_clusters / clusters_containing_term) + 1
score(term)        = TF × IDF
```

This scores terms by how **characteristic** they are of a specific cluster relative to all others. "Internet Aesthetics" appears in 20 clusters → low IDF → demoted. "Gyaru" appears in 1–2 clusters → high IDF → promoted.

### Hierarchical uniqueness constraint (Option B)

An additional constraint ensures no two clusters at the same zoom level share a label:

1. Clusters are processed in descending size order
2. Once a label is claimed by a cluster, it is excluded from all subsequent clusters at that level
3. Level-2 labels are also excluded from using their parent Level-1 label

This forces the label hierarchy to be informative at every zoom level rather than repeating the same descriptor.

### Label positions

Labels are placed at the **degree-weighted centroid** of their cluster, nudged 78% toward the nearest actual node. This avoids floating in empty UMAP space (non-convex clusters can have centroids in void regions) while still remaining central to the cluster mass.

---

## Rendering

Built with [Pixi.js v7](https://pixijs.com/) (WebGL).

| Layer | Description |
|---|---|
| Density (pre-baked) | Wide blurred halos per node baked into a static `RenderTexture` at 25% resolution at startup. Zero per-frame cost. Creates the coloured territory landscape. |
| Edges | 5,307 lines drawn as a single batched `Graphics` object. Coloured by source community, opacity proportional to edge weight. |
| Nodes | One `Graphics` per node, sorted large-to-small so small nodes sit on top of the stack and receive pointer events first (making overlapping nodes individually selectable). |
| Labels | `PIXI.Text` objects scaled inversely to viewport so text stays screen-size-constant regardless of zoom. Fade in/out based on zoom thresholds. |
| Glitter | 180 drifting particle `Graphics`, positions biased toward dense areas of the graph. Alpha oscillates sinusoidally. |

### Zoom label thresholds

| Zoom scale | Visible labels |
|---|---|
| < 0.28 | Level-1 cluster names (serif, large) |
| 0.28 – ∞ | Level-2 subcluster names (colored by parent community) |
| > 0.85 | Individual node names |

---

## Reproduction

```bash
# 1. Scrape the wiki
Rscript scraper.R

# 2. Compute layout + communities
python3 process.py

# 3. Fetch cover images
python3 fetch_images.py

# 4. Serve locally
cd public && python3 -m http.server 8765
```

Dependencies: `R` (httr, XML, tidyverse, jsonlite, arrow), `python3` (networkx, umap-learn, scikit-learn, python-louvain, fa2, pandas, numpy, requests).

---

## File structure

```
.
├── scraper.R                  # Wiki scraper (R)
├── process.py                 # Layout + community pipeline (Python)
├── fetch_images.py            # Cover image URL fetcher (Python)
├── aesthetics_wiki_data.csv   # Raw scraped data
├── public/
│   ├── index.html             # App shell
│   ├── style.css              # Vaporwave design system
│   ├── app.js                 # Pixi.js visualization
│   ├── nodes.json             # Node positions, communities, infobox data
│   └── edges.json             # Edge list with weights
└── README.md
```
