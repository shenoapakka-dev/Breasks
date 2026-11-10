#!/usr/bin/env python3
"""
Builds data/area_codes.json for the Breasks ETM Trip Planner extension.

Source: Area_Codes_All_Emirates_Inc_updated.xlsx (uploaded by the user).
Adds an approximate road-distance-from-warehouse (km) per area code, used
only to ORDER stops within a trip (farthest -> nearest) and to assign
orders to trips/slots. These are hand-estimated real-world road distances
from the warehouse (Pan Home DC, Al Sajaa, Sharjah -> SHJ area code 122),
not pulled from a mapping API. They are editable later from the
extension's Options page (per-area override), and this script is the
single source of truth if better numbers arrive later.
"""
import json
import openpyxl

import os
SRC = os.path.join(os.path.dirname(__file__), "..", "data", "source", "Area_Codes_All_Emirates.xlsx")
OUT = "/home/user/Breasks/data/area_codes.json"
OUT_JS = "/home/user/Breasks/data/area_codes.js"

WAREHOUSE_CODE = "122"
WAREHOUSE_EMIRATE = "SHJ"
WAREHOUSE_LABEL = "Al Sajaa, Sharjah (Pan Home DC)"

# code -> approx road km from warehouse (Al Sajaa, Sharjah)
DISTANCE_KM = {
    # SHJ - warehouse's own emirate
    "110": 18, "111": 15, "112": 14, "113": 16, "114": 15, "115": 17,
    "116": 18, "117": 8, "118": 10, "119": 10, "120": 10, "121": 8,
    "122": 0,
    # DXB - ordered roughly Sharjah-border -> Jebel Ali/DWC
    "210": 20, "211": 28, "212": 25, "213": 27, "214": 30, "215": 35,
    "216": 40, "217": 45, "218": 42, "219": 20, "220": 20, "221": 24,
    "222": 25, "223": 26, "224": 32, "225": 33, "226": 42, "227": 22,
    "228": 28, "229": 35, "230": 48, "231": 50, "232": 52, "233": 130, "234": 55,
    "235": 58,
    # AUH - Abu Dhabi city + Al Dhafra western region (very far) + Al Ain
    "310": 145, "311": 148, "312": 140, "313": 142, "314": 138,
    "315": 125, "316": 110, "317": 115, "318": 130, "319": 128,
    "330": 160, "331": 120,
    "321": 260, "322": 300, "323": 330, "324": 350, "325": 360,
    "326": 340, "327": 345, "328": 355, "329": 365,
    "418": 180,
    # AIN - Al Ain
    "410": 165, "411": 170, "412": 172, "413": 175, "414": 178,
    "415": 180, "416": 182, "417": 185, "419": 190, "420": 195,
    # AJM - Ajman, right next to Sharjah
    "510": 15, "511": 12, "512": 10, "513": 12, "514": 15, "515": 8,
    # RAK - Ras Al Khaimah
    "610": 95, "611": 90, "612": 98, "613": 102, "614": 100,
    "615": 108, "616": 112, "617": 115, "618": 118,
    # FUJ - Fujairah (through the mountains / Masafi road)
    "710": 115, "711": 120, "712": 118, "713": 125, "714": 130,
    "715": 110, "716": 135, "717": 140, "718": 138, "719": 142,
    # UAQ - Umm Al Quwain
    "810": 40, "811": 42, "812": 45, "813": 50,
}

SHEETS = ["Tuesday DXB", " Saturday AUH &  AIN", "SHJ", "DXB", "AUH", "AIN", "AJM", "RAK", "FUJ", "UAQ"]

def emirate_from_code(code, sheet_name):
    c = int(code)
    if 110 <= c <= 199: return "SHJ"
    if 210 <= c <= 299: return "DXB"
    if 310 <= c <= 399: return "AUH"
    if 410 <= c <= 499: return "AIN"
    if 510 <= c <= 599: return "AJM"
    if 610 <= c <= 699: return "RAK"
    if 710 <= c <= 799: return "FUJ"
    if 810 <= c <= 899: return "UAQ"
    return sheet_name.strip()

def main():
    wb = openpyxl.load_workbook(SRC, data_only=True)
    areas = {}
    skipped = []

    for sheet_name in SHEETS:
        ws = wb[sheet_name]
        rows = list(ws.iter_rows(values_only=True))
        for row in rows:
            # find a cell in this row that looks like a 3-digit area code
            code = None
            subareas = None
            for idx, val in enumerate(row):
                if val is None:
                    continue
                if isinstance(val, (int, float)) and 100 <= int(val) <= 899:
                    code = str(int(val))
                    # sub-areas text is usually the next non-empty cell
                    for j in range(idx + 1, len(row)):
                        if row[j] and isinstance(row[j], str):
                            subareas = row[j].strip()
                            break
                    break
            if code is None or subareas is None:
                continue
            if code in areas:
                continue  # already captured from an earlier sheet pass
            emirate = emirate_from_code(code, sheet_name)
            dist = DISTANCE_KM.get(code)
            if dist is None:
                skipped.append((code, subareas))
                dist = 999  # flag as unknown -> extension will warn & ask user
            areas[code] = {
                "code": code,
                "emirate": emirate,
                "label": subareas,
                "distanceKm": dist,
                "distanceIsEstimate": True,
            }

    data = {
        "warehouse": {
            "code": WAREHOUSE_CODE,
            "emirate": WAREHOUSE_EMIRATE,
            "label": WAREHOUSE_LABEL,
        },
        "generatedNote": (
            "distanceKm values are hand-estimated approximate ROAD distances "
            "(in km) from the Pan Home warehouse in Al Sajaa, Sharjah, used only "
            "to sequence stops within a trip (farthest first, nearest last) and "
            "to help assign orders to trips. They are NOT from a mapping API. "
            "Adjust them any time from the extension's Options page; your edits "
            "are stored locally and override these defaults."
        ),
        "areas": areas,
    }

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    with open(OUT_JS, "w", encoding="utf-8") as f:
        f.write("// Auto-generated by scripts/build_area_data.py from the Area Codes xlsx.\n")
        f.write("// Do not hand-edit area distances here long-term; use the Options page\n")
        f.write("// (stored overrides win over these defaults) or re-run the build script.\n")
        f.write("window.BREAKS_AREA_DATA = ")
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write(";\n")

    print(f"Wrote {len(areas)} area codes to {OUT} and {OUT_JS}")
    if skipped:
        print(f"WARNING: {len(skipped)} codes had no distance estimate (defaulted to 999):")
        for c, s in skipped:
            print(f"  {c}: {s}")

if __name__ == "__main__":
    main()
