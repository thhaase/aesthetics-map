"""
Phase 1: Data processing pipeline
- Builds weighted edge list from infobox connection columns
- Runs ForceAtlas2 layout for 2D positions
- Runs 3-level Louvain community detection
- Auto-labels clusters from wiki categories
- Exports nodes.json and edges.json
"""

import json
import os
import re
import warnings
from collections import Counter, defaultdict

import networkx as nx
import numpy as np
import pandas as pd
import community as community_louvain

warnings.filterwarnings("ignore")

# ── Config ────────────────────────────────────────────────────────────────────

DATA_PATH  = "aesthetics_wiki_data.csv"
NODES_OUT  = "nodes.json"
EDGES_OUT  = "edges.json"

EDGE_WEIGHTS = {
    "relatedaesthetics": 1.0,
    "overlapswith":      1.2,
    "subgenres":         1.5,
}

# Louvain resolution per level — higher = more, smaller communities
RESOLUTION = { 1: 1.0, 2: 1.3, 3: 1.6 }

# Min cluster size to subdivide further
MIN_SUBDIVIDE = 12

META_CATEGORIES = {
    "Needs_work", "Good_Articles", "Awaiting_Validation",
    "Aesthetics_Wiki_Articles", "Wiki-Coined_Terms", "Sensitive_Content",
    "Needs_Infobox", "Stub", "Featured_Articles",
    "2020s", "2010s", "2000s", "1990s", "1980s", "1970s", "1960s", "1950s",
    "1940s", "1930s", "1920s", "1910s", "1900s",
    "Aesthetics", "Fashion", "Music",
    "Nautical", "Oceans and islands", "Vacation, amusement, and recreation",
    "Location-based Aesthetics",
}

# ── Helpers ───────────────────────────────────────────────────────────────────

def split_field(val):
    if pd.isna(val) or not str(val).strip():
        return []
    parts = re.split(r"\s*;\s*", str(val))
    result = []
    for p in parts:
        result.extend(re.split(r"\s*,\s*", p))
    return [s.strip() for s in result if s.strip()]


def clean_cat(c):
    return c.replace("_", " ").strip()


def top_labels(nodes, node_cats, n=3):
    """Raw frequency count — used only to build TF-IDF corpus, not for final labels."""
    cnt = Counter()
    for node in nodes:
        for c in node_cats.get(node, []):
            cnt[c] += 1
    return [l for l, _ in cnt.most_common(10) if l not in META_CATEGORIES][:n] or ["(unlabelled)"]


def tfidf_labels(cluster_cat_bags, exclude=(), n=1):
    """
    Given a list of category bags (one per cluster), return the most distinctive
    label for each cluster using cluster-level TF-IDF.

    cluster_cat_bags : list of Counter  — one per cluster
    exclude          : set of labels already used at a higher/sibling level
    n                : how many top labels to return per cluster

    TF  = category frequency within this cluster (normalised)
    IDF = log(N_clusters / clusters_containing_category)
    """
    n_clusters = len(cluster_cat_bags)
    # document frequency: how many clusters contain each category
    df = Counter()
    for bag in cluster_cat_bags:
        for cat in bag:
            df[cat] += 1

    results = []
    used = set(exclude)
    for bag in cluster_cat_bags:
        total = max(sum(bag.values()), 1)
        scored = {}
        for cat, freq in bag.items():
            if cat in META_CATEGORIES:
                continue
            tf  = freq / total
            idf = np.log(n_clusters / df[cat]) + 1   # +1 smoothing
            scored[cat] = tf * idf

        # Pick top n labels not already used at this level
        top = [cat for cat, _ in sorted(scored.items(), key=lambda x: -x[1])
               if cat not in used][:n]
        if not top:
            top = ["(unlabelled)"]
        results.append(top)
        used.update(top)   # Option B: sibling exclusion — once claimed, unavailable

    return results


def nudged_pos(members, pos_norm, degree_map, nudge=0.78):
    """Degree-weighted centroid nudged slightly toward the nearest node.
    Avoids floating in empty UMAP space without hard-snapping onto a node."""
    if not members:
        return (0.0, 0.0)
    xs = np.array([pos_norm[m][0] for m in members])
    ys = np.array([pos_norm[m][1] for m in members])
    if len(members) == 1:
        return (float(xs[0]), float(ys[0]))
    weights = np.array([max(degree_map.get(m, 1.0), 1e-9) for m in members])
    weights = weights / weights.sum()
    cx = float((xs * weights).sum())
    cy = float((ys * weights).sum())
    dists = (xs - cx) ** 2 + (ys - cy) ** 2
    nx_ = float(xs[np.argmin(dists)])
    ny_ = float(ys[np.argmin(dists)])
    rx = cx + nudge * (nx_ - cx)
    ry = cy + nudge * (ny_ - cy)
    # Guard against any remaining NaN/Inf
    if not (np.isfinite(rx) and np.isfinite(ry)):
        return (float(xs[0]), float(ys[0]))
    return (rx, ry)


def louvain_partition(subgraph, resolution):
    if subgraph.number_of_edges() == 0:
        return {n: 0 for n in subgraph.nodes()}
    return community_louvain.best_partition(subgraph, weight="weight",
                                            resolution=resolution, random_state=42)


# ── Step 1: Load data ─────────────────────────────────────────────────────────

print("── Step 1: Loading data ──")
df = pd.read_csv(DATA_PATH)
df["title"] = df["title"].str.strip()
all_titles  = set(df["title"])
print(f"  {len(df)} pages loaded")

# Node categories (filtered)
node_cats = {}
for _, row in df.iterrows():
    cats = []
    if pd.notna(row.get("categories")):
        for c in row["categories"].split(";"):
            c = clean_cat(c.strip())
            if c and c.replace(" ", "_") not in META_CATEGORIES and c not in META_CATEGORIES:
                cats.append(c)
    node_cats[row["title"]] = cats

# ── Step 2: Build weighted graph ──────────────────────────────────────────────

print("── Step 2: Building weighted graph ──")
G = nx.Graph()
G.add_nodes_from(df["title"])

ec = Counter()
for _, row in df.iterrows():
    src = row["title"]
    for col, base_w in EDGE_WEIGHTS.items():
        for tgt in split_field(row.get(col)):
            if tgt in all_titles and tgt != src:
                ec[tuple(sorted([src, tgt]))] += base_w

for (u, v), w in ec.items():
    G.add_edge(u, v, weight=w)

print(f"  Nodes: {G.number_of_nodes()}  Edges: {G.number_of_edges()}  Isolated: {len(list(nx.isolates(G)))}")

# ── Step 3: 2D layout via UMAP on graph + text distance ───────────────────────
#
# Positions should reflect semantic similarity, not just graph topology.
# We combine two distance signals:
#   - Graph distance: normalised shortest-path lengths (topology)
#   - Text distance:  TF-IDF cosine distance on article text (semantics)
# Then run UMAP with metric='precomputed' on the blended matrix.

print("── Step 3: Computing 2D layout (UMAP + graph + text) ──")

from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_distances
from sklearn.preprocessing import MinMaxScaler
import umap as umap_lib
import scipy.sparse as sp

node_list = list(G.nodes())   # fixed order for matrix indices
N = len(node_list)
idx = {n: i for i, n in enumerate(node_list)}
isolated_nodes = set(nx.isolates(G))

# ── 3a: Graph distance matrix ──────────────────────────────────────────────
print("  Building graph distance matrix…")
# Convert edge weights (similarity) to distance: d = 1 / weight
# Then shortest-path through the graph
G_dist = nx.Graph()
G_dist.add_nodes_from(node_list)
for u, v, d in G.edges(data=True):
    G_dist.add_edge(u, v, weight=1.0 / max(d["weight"], 0.01))

# All-pairs shortest path (sparse: use Dijkstra per source)
graph_dist = np.full((N, N), 1.0)   # default = max distance for disconnected pairs
np.fill_diagonal(graph_dist, 0.0)

lengths = dict(nx.all_pairs_dijkstra_path_length(G_dist, cutoff=None, weight="weight"))
for src, targets in lengths.items():
    i = idx[src]
    for tgt, d in targets.items():
        j = idx[tgt]
        graph_dist[i, j] = d

# Normalise to [0, 1]
max_finite = graph_dist[graph_dist < 1.0].max() if (graph_dist < 1.0).any() else 1.0
graph_dist = np.clip(graph_dist / max_finite, 0.0, 1.0)
print(f"  Graph dist — mean={graph_dist.mean():.3f}  "
      f"disconnected pairs: {(graph_dist >= 1.0).sum() - N}")

# ── 3b: Text distance matrix (TF-IDF cosine) ──────────────────────────────
print("  Building text distance matrix…")
texts = []
for n in node_list:
    row = df[df["title"] == n]
    t = row["text"].values[0] if len(row) and pd.notna(row["text"].values[0]) else ""
    # Supplement with categories and key motifs for richer signal
    for col in ["categories", "key_motifs", "key_values", "key_colours"]:
        v = row[col].values[0] if len(row) and col in row.columns and pd.notna(row[col].values[0]) else ""
        t += " " + str(v)
    texts.append(t.strip() or n)  # fallback to title if no text

tfidf = TfidfVectorizer(max_features=8000, sublinear_tf=True,
                        ngram_range=(1, 2), min_df=2)
tfidf_mat = tfidf.fit_transform(texts)
text_dist = cosine_distances(tfidf_mat).astype(np.float32)
print(f"  Text dist   — mean={text_dist.mean():.3f}  vocab={len(tfidf.vocabulary_)}")

# ── 3c: Blend and run UMAP ─────────────────────────────────────────────────
# Weight: 55% graph topology, 45% semantic text
# For isolated nodes graph_dist=1.0 so text similarity dominates their placement
GRAPH_WEIGHT = 0.55
combined = GRAPH_WEIGHT * graph_dist + (1 - GRAPH_WEIGHT) * text_dist
combined = combined.astype(np.float32)
# Symmetrise (should already be symmetric but floating-point can drift)
combined = (combined + combined.T) / 2
np.fill_diagonal(combined, 0.0)

print("  Running UMAP (this takes ~30s)…")
reducer = umap_lib.UMAP(
    n_components=2,
    metric="precomputed",
    n_neighbors=18,
    min_dist=0.25,
    spread=1.2,
    random_state=42,
    low_memory=False,
    n_epochs=500,
)
embedding = reducer.fit_transform(combined)
layout_method = "UMAP (graph 55% + TF-IDF 45%)"
print(f"  Embedding shape: {embedding.shape}")

# ── 3d: Normalise positions ────────────────────────────────────────────────
connected_idx = [idx[n] for n in node_list if n not in isolated_nodes]
con_xy = embedding[connected_idx]
cx, cy = con_xy[:, 0].mean(), con_xy[:, 1].mean()
spread = max(
    np.percentile(np.abs(con_xy[:, 0] - cx), 95),
    np.percentile(np.abs(con_xy[:, 1] - cy), 95),
    1e-6,
)
pos_norm = {}
for i, n in enumerate(node_list):
    pos_norm[n] = (
        float((embedding[i, 0] - cx) / spread),
        float((embedding[i, 1] - cy) / spread),
    )

# Isolated nodes: place on a ring outside the main cluster
iso_list = sorted(isolated_nodes)
ring_r = 1.45
for k, n in enumerate(iso_list):
    angle = 2 * np.pi * k / max(len(iso_list), 1)
    pos_norm[n] = (float(ring_r * np.cos(angle)), float(ring_r * np.sin(angle)))

con_norms = np.array([pos_norm[n] for n in node_list if n not in isolated_nodes])
print(f"  Layout: {layout_method}")
print(f"  Connected range — "
      f"x:[{con_norms[:,0].min():.2f},{con_norms[:,0].max():.2f}] "
      f"y:[{con_norms[:,1].min():.2f},{con_norms[:,1].max():.2f}]")

# ── Step 4: 2-level community detection ───────────────────────────────────────

degree_map = dict(G.degree(weight="weight"))  # needed by nudged_pos

print("── Step 4: 2-level Louvain community detection ──")

# Level 1 — full graph
l1_part  = louvain_partition(G, RESOLUTION[1])
l1_sizes = Counter(l1_part.values())
l1_order = sorted(l1_sizes, key=lambda x: -l1_sizes[x])

# Gather all L1 member sets and category bags
l1_members  = {lid: [n for n, c in l1_part.items() if c == lid] for lid in l1_order}
l1_cat_bags = [Counter(c for n in l1_members[lid] for c in node_cats.get(n, []))
               for lid in l1_order]

# TF-IDF labels for L1 — no exclusion at this level
l1_tfidf_labels = tfidf_labels(l1_cat_bags, exclude=set(), n=1)

# community_tree: gid → {id, level, parent, children, labels, size, cx, cy}
community_tree = {}
node_l1, node_l2 = {}, {}
global_id = 0

# L1 pass — build tree entries
l1_gids = {}   # local_l1_id → global gid
for i, local_l1 in enumerate(l1_order):
    gid_l1 = global_id; global_id += 1
    l1_gids[local_l1] = gid_l1
    members = l1_members[local_l1]
    for n in members:
        node_l1[n] = gid_l1
    mx, my = nudged_pos(members, pos_norm, degree_map)
    community_tree[gid_l1] = {
        "id": gid_l1, "level": 1, "parent": None, "children": [],
        "labels": l1_tfidf_labels[i], "size": len(members),
        "cx": round(mx, 6),
        "cy": round(my, 6),
    }

# L2 pass — subdivide each L1, label with TF-IDF excluding parent + siblings
for local_l1 in l1_order:
    gid_l1  = l1_gids[local_l1]
    members_l1 = l1_members[local_l1]
    parent_labels = set(community_tree[gid_l1]["labels"])

    sub1    = G.subgraph(members_l1).copy()
    l2_part = louvain_partition(sub1, RESOLUTION[2])
    l2_sizes = Counter(l2_part.values())
    l2_order = sorted(l2_sizes, key=lambda x: -l2_sizes[x])

    l2_members_map  = {lid: [n for n, c in l2_part.items() if c == lid] for lid in l2_order}
    l2_cat_bags     = [Counter(c for n in l2_members_map[lid] for c in node_cats.get(n, []))
                       for lid in l2_order]

    # Option B: exclude parent label so children must be more specific
    l2_labels = tfidf_labels(l2_cat_bags, exclude=parent_labels, n=1)

    for j, local_l2 in enumerate(l2_order):
        gid_l2 = global_id; global_id += 1
        members = l2_members_map[local_l2]
        for n in members:
            node_l2[n] = gid_l2
        mx, my = nudged_pos(members, pos_norm, degree_map)
        community_tree[gid_l2] = {
            "id": gid_l2, "level": 2, "parent": gid_l1, "children": [],
            "labels": l2_labels[j], "size": len(members),
            "cx": round(mx, 6),
            "cy": round(my, 6),
        }
        community_tree[gid_l1]["children"].append(gid_l2)

print(f"  L1 communities: {len([c for c in community_tree.values() if c['level']==1])}")
print(f"  L2 communities: {len([c for c in community_tree.values() if c['level']==2])}")

# ── Step 5: Print tree ────────────────────────────────────────────────────────

print("\n── Community tree ──")

def example_nodes(members, n=4):
    return sorted(members, key=lambda x: -degree_map.get(x, 0))[:n]

for gid_l1, c1 in sorted(community_tree.items(), key=lambda x: -x[1]["size"]):
    if c1["level"] != 1 or c1["size"] < 2:
        continue
    print(f"\n[{c1['size']:3d}] {' / '.join(c1['labels'])}")
    for gid_l2 in c1["children"]:
        c2 = community_tree[gid_l2]
        if c2["size"] < 2:
            continue
        members_l2 = [n for n, v in node_l2.items() if v == gid_l2]
        eg2 = ", ".join(example_nodes(members_l2))
        print(f"  ├─ [{c2['size']:3d}] {' / '.join(c2['labels'])}  — e.g. {eg2}")

# ── Step 6: Build output JSON ─────────────────────────────────────────────────

print("\n── Step 6: Building output JSON ──")

# Preserve image URLs from a previous nodes.json run if present
existing_images = {}
if os.path.exists(NODES_OUT):
    try:
        with open(NODES_OUT) as _f:
            _old = json.load(_f)
        for _n in _old.get("nodes", []):
            if "image_url" in _n:
                existing_images[_n["id"]] = _n["image_url"]
        if existing_images:
            print(f"  Preserved {len(existing_images)} existing image URLs")
    except Exception:
        pass

max_degree = max(degree_map.values()) if degree_map else 1

SIDE_PANEL_FIELDS = [
    "other_names", "decade_of_origin", "location_of_origin",
    "creators", "coined_by", "key_motifs", "key_colours", "key_values",
    "primary_platform", "primaryplatform", "related_media", "relatedmedia",
    "related_brands", "relatedbrands", "iconic_figures", "iconicfigures",
    "relatedaesthetics", "subgenres", "overlapswith",
]

CANON = {
    "relatedaesthetics": "related_aesthetics",
    "overlapswith":      "overlaps_with",
    "primaryplatform":   "primary_platform",
    "relatedmedia":      "related_media",
    "relatedbrands":     "related_brands",
    "iconicfigures":     "iconic_figures",
}

nodes_out = []
for _, row in df.iterrows():
    title = row["title"]
    x, y  = pos_norm.get(title, (0.0, 0.0))
    deg   = degree_map.get(title, 0)

    info = {}
    for f in SIDE_PANEL_FIELDS:
        val = row.get(f)
        if pd.notna(val) and str(val).strip():
            key = CANON.get(f, f)
            if key not in info:
                info[key] = str(val).strip()

    node_entry = {
        "id":          title,
        "x":           round(x, 6),
        "y":           round(y, 6),
        "c1":          node_l1.get(title, -1),
        "c2":          node_l2.get(title, -1),
        "c3":          node_l2.get(title, -1),  # c3 unused, alias to c2
        "degree":      round(deg, 3),
        "degree_norm": round(deg / max_degree, 4),
        "url":         str(row.get("url", "")),
        "categories":  node_cats.get(title, []),
        "info":        info,
    }
    if title in existing_images:
        node_entry["image_url"] = existing_images[title]
    nodes_out.append(node_entry)

edges_out = [
    {"source": u, "target": v, "weight": round(d.get("weight", 1.0), 4)}
    for u, v, d in G.edges(data=True)
]

# ── Step 7: Save ──────────────────────────────────────────────────────────────

import os
os.makedirs("public", exist_ok=True)

def safe_json(obj):
    """Replace NaN/Inf with 0 so JSON.parse never chokes."""
    import math
    if isinstance(obj, float):
        return 0.0 if not math.isfinite(obj) else obj
    if isinstance(obj, dict):
        return {k: safe_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [safe_json(v) for v in obj]
    return obj

with open(NODES_OUT, "w") as f:
    json.dump(safe_json({
        "nodes":      nodes_out,
        "communities": list(community_tree.values()),
    }), f, separators=(",", ":"))

with open(EDGES_OUT, "w") as f:
    json.dump({"edges": edges_out}, f, separators=(",", ":"))

print(f"  Saved {len(nodes_out)} nodes → {NODES_OUT}")
print(f"  Saved {len(edges_out)} edges → {EDGES_OUT}")
print(f"  Community tree: {len(community_tree)} total entries")
print(f"\n  Layout: {layout_method}  |  Isolated: {sum(1 for n in nodes_out if n['degree']==0)}")
