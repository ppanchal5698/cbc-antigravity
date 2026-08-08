"""
Demo Agent Sandbox Script
Simulates extracting, calculating, and exporting an isolated takeoff JSON to sandbox/outputs/
"""

import json
from pathlib import Path
import os
from cbc_engine import engine

print("Starting isolated sandbox takeoff script...")
print(f"CWD: {os.getcwd()}")

# 1. Expand a hardware set
hw = engine.expand_hardware_set("HW Set 01 - Interior Office", door_size="3070")

# 2. Derive throat
throat = engine.calculate_frame_throat("3-5/8 stud with 5/8 drywall")

# 3. Compute quote line
line = engine.calculate_quote_line(
    cost=245.50,
    margin=0.27,
    quantity=4,
    cost_source="catalog_list_x_multiplier",
    cost_source_detail="Hager PB#18",
)

result = {
    "hardware_set": hw,
    "frame_throat": throat,
    "quote_line": line,
}

# 4. Save to sandbox outputs
output_dir = Path(os.environ.get("CBC_OUTPUTS_ROOT", str(Path(__file__).resolve().parent.parent / "outputs")))
output_dir.mkdir(parents=True, exist_ok=True)
output_path = output_dir / "demo_takeoff_result.json"
output_path.write_text(json.dumps(result, indent=2), encoding="utf-8")

print(f"Takeoff calculated successfully! Saved output to {output_path.name}")
print(f"Total Extended Sale: ${line['ext_sale']:.2f}")

