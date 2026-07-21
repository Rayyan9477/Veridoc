"""Start the Celery worker with .env loaded into the process environment.

Celery does not read .env on its own, and Veridoc's nested settings blocks
(vlm.qwen_cloud, etc.) resolve from os.environ rather than the parent model's
env_file -- so without this the worker would silently run on the LM Studio
defaults instead of Qwen Cloud.

    python scripts/run_worker.py
"""

import os
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))
os.chdir(REPO)

from dotenv import load_dotenv  # noqa: E402

load_dotenv(REPO / ".env", override=True)

from src.queue.celery_app import celery_app  # noqa: E402

if __name__ == "__main__":
    print(f"broker : {celery_app.conf.broker_url}")
    print(f"backend: {celery_app.conf.result_backend}")
    print(f"vlm    : {os.environ.get('VLM_BACKEND')} / {os.environ.get('VLM_ROLE_MODELS')}")
    celery_app.worker_main(
        [
            "worker",
            "--loglevel=info",
            "--pool=solo",  # Windows: prefork is unsupported
            "-Q",
            "document_processing,batch_processing,reprocessing,priority",
        ]
    )
