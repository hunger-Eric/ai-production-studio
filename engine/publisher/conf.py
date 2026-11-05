import os
from pathlib import Path


BASE_DIR = Path(os.environ["STUDIO_PUBLISH_STATE"])
if not BASE_DIR.is_absolute():
    raise ValueError("STUDIO_PUBLISH_STATE must be an absolute customer workspace path")
LOCAL_CHROME_PATH = ""
LOCAL_CHROME_HEADLESS = True
DEBUG_MODE = True
