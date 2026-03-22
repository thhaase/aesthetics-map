"""
Fetch cover image URLs for all aesthetics via the MediaWiki pageimages API.
Batches 50 titles per request. Adds image_url field to nodes in nodes.json.
"""

import json, time, requests
from urllib.parse import quote

API = "https://aesthetics.fandom.com/api.php"
BATCH = 50
DELAY = 1.5

with open("public/nodes.json") as f:
    data = json.load(f)

nodes = data["nodes"]
titles = [n["id"] for n in nodes]

print(f"Fetching images for {len(titles)} pages in batches of {BATCH}…")

image_map = {}

for i in range(0, len(titles), BATCH):
    batch = titles[i : i + BATCH]
    joined = "|".join(batch)
    resp = requests.get(API, params={
        "action": "query",
        "titles": joined,
        "prop": "pageimages",
        "piprop": "original",
        "format": "json",
    }, headers={"User-Agent": "aesthetics-map/1.0"}, timeout=15)

    if resp.status_code != 200:
        print(f"  ⚠ HTTP {resp.status_code} on batch {i//BATCH + 1}, skipping")
        continue

    pages = resp.json().get("query", {}).get("pages", {})
    for page in pages.values():
        title = page.get("title", "")
        src = page.get("original", {}).get("source")
        if src:
            image_map[title] = src

    found = sum(1 for t in batch if t in image_map)
    print(f"  Batch {i//BATCH + 1}/{(len(titles)-1)//BATCH + 1} — {found}/{len(batch)} images found")
    time.sleep(DELAY)

# Attach image_url to each node
for n in nodes:
    url = image_map.get(n["id"])
    if url:
        n["image_url"] = url

covered = sum(1 for n in nodes if "image_url" in n)
print(f"\n✓ {covered}/{len(nodes)} nodes have a cover image")

with open("public/nodes.json", "w") as f:
    json.dump(data, f, separators=(",", ":"))
print("✓ Saved public/nodes.json")
