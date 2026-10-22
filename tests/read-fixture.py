"""Read the supplied workbook using only Python's XML and ZIP standard library."""
from pathlib import Path
import json
import re
import xml.etree.ElementTree as ET
from zipfile import ZipFile

ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
with ZipFile(Path(__file__).parent / "fixtures/dados.xlsx") as archive:
    shared = []
    if "xl/sharedStrings.xml" in archive.namelist():
        shared = ["".join(n.itertext()) for n in ET.fromstring(archive.read("xl/sharedStrings.xml")).findall("m:si", ns)]
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    result = {}
    for i, sheet in enumerate(workbook.find("m:sheets", ns), 1):
        rows = []
        cells = {}
        xml = ET.fromstring(archive.read(f"xl/worksheets/sheet{i}.xml"))
        for row in xml.findall("m:sheetData/m:row", ns):
            values = {}
            for cell in row:
                value = cell.find("m:v", ns)
                text = value.text if value is not None else ""
                if cell.get("t") == "s":
                    text = shared[int(text)]
                elif cell.get("t") == "inlineStr":
                    text = "".join(cell.find("m:is", ns).itertext())
                values[re.sub(r"\d", "", cell.get("r"))] = text
                cells[cell.get("r")] = {"v": text, "t": "s"}
            rows.append(values)
        headers = rows[0]
        records = [{headers[k]: v for k, v in row.items() if k in headers} for row in rows[1:]]
        cells["!ref"] = xml.find("m:dimension", ns).get("ref")
        result[sheet.get("name")] = {"headers": list(headers.values()), "rows": records, "cells": cells}
print(json.dumps({
    "programRows": result["Programas"]["rows"],
    "extRows": result["Além do mapa programático"]["rows"],
    "extHeaders": result["Além do mapa programático"]["headers"],
    "sheets": {name: data["cells"] for name, data in result.items()},
}, ensure_ascii=False))
