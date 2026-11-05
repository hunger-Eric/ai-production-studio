from pathlib import Path

from conf import BASE_DIR

Path(BASE_DIR / "cookies").mkdir(parents=True, exist_ok=True)
