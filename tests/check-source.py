"""Check source structure and consistency without a browser."""
from pathlib import Path
from html.parser import HTMLParser
import base64
import json

root = Path(__file__).resolve().parent.parent
text = (root / "site/index.html").read_text()

class Structure(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.references = []
        self.headings = []
        self.main = 0
        self.images = []
    def handle_starttag(self, tag, attributes):
        data = dict(attributes)
        if "id" in data:
            self.ids.append(data["id"])
        if "aria-labelledby" in data:
            self.references.extend(data["aria-labelledby"].split())
        if tag == "h1":
            self.headings.append(tag)
        if tag == "main":
            self.main += 1
        if tag == "img":
            assert data.get("alt"), "Images need alternative text"
            self.images.append(data["src"])

parsed = Structure()
parsed.feed(text)
assert len(parsed.ids) == len(set(parsed.ids)), "Duplicate IDs"
assert all(ref in parsed.ids for ref in parsed.references)
assert parsed.main == 1 and len(parsed.headings) == 1
assert "cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5" not in text
assert "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js" in text
assert 'name="viewport"' in text
assert 'role="status"' in text and "aria-live" in text
assert "font-family=" in text
for image in parsed.images:
    assert image.startswith("data:image/")
    assert len(base64.b64decode(image.split(",", 1)[1])) > 0
manifest = json.loads((root / ".openai/hosting.json").read_text())
assert "static" not in manifest
assert manifest["r2"] == "BUCKET"
assert (root / "worker/index.js").exists()
print("PASS — HTML structure, embedded images, accessibility hooks and hosting manifest")
