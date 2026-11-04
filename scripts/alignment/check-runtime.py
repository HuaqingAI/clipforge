"""Offline readiness probe for ClipForge's English CTC alignment runtime."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-dir", type=Path, required=True)
    parser.add_argument("--packages-only", action="store_true")
    parser.add_argument("--prepare-nltk", action="store_true")
    parser.add_argument("--write-ready", action="store_true")
    args = parser.parse_args()
    runtime = args.runtime_dir.resolve()
    spec = json.loads((Path(__file__).with_name("runtime-spec.json")).read_text(encoding="utf-8"))
    os.environ.update({
        "HF_HOME": str(runtime / "hf-cache"),
        "NLTK_DATA": str(runtime / "nltk-data"),
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "TOKENIZERS_PARALLELISM": "false",
    })
    for package, expected in spec["packages"].items():
        actual = importlib.metadata.version(package)
        # macOS wheels are CPU-only but do not use PyTorch's +cpu suffix.
        if actual != expected and not (sys.platform == "darwin" and actual == expected.removesuffix("+cpu")):
            raise RuntimeError(f"{package}: expected {expected}, found {actual}")
    import numpy as np
    import torch
    import nltk
    from whisperx.alignment import load_align_model, align
    from transformers.utils import logging as transformer_logging
    transformer_logging.set_verbosity_error()
    if args.packages_only:
        print(json.dumps({"packagesReady": True, "python": sys.executable}))
        return
    nltk.data.path.insert(0, str(runtime / "nltk-data"))
    try:
        nltk.data.find("tokenizers/punkt_tab/english/")
        nltk.tokenize.sent_tokenize("This is an English alignment check.", language="english")
    except (LookupError, OSError, ValueError):
        if not args.prepare_nltk:
            raise RuntimeError("English sentence tokenizer is missing; run start.cmd to initialize it")
        nltk.download("punkt_tab", download_dir=str(runtime / "nltk-data"), quiet=False, raise_on_error=True, force=True)
    nltk.tokenize.sent_tokenize("This is an English alignment check.", language="english")
    for item in spec["modelFiles"]:
        file = runtime / "model" / item["name"]
        if file.stat().st_size != item["size"]:
            raise RuntimeError(f"Model file is incomplete: {item['name']}")
        with file.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != item["sha256"]:
                raise RuntimeError(f"Model checksum failed: {item['name']}")
    torch.set_num_threads(min(4, os.cpu_count() or 1))
    model, metadata = load_align_model("en", "cpu", model_name=str(runtime / "model"), model_cache_only=True)
    # Exercise native PyTorch, the checkpoint and the actual WhisperX alignment
    # module without transcription, downloading another model or inventing words.
    with torch.inference_mode():
        output = model(torch.from_numpy(np.zeros(16000, dtype=np.float32)).unsqueeze(0)).logits
    if output.ndim != 3 or output.shape[1] < 1 or metadata.get("language") != "en":
        raise RuntimeError("The English alignment model failed its CPU inference check")
    result = {
        "schemaVersion": spec["schemaVersion"],
        "runtimeVersion": spec["runtimeVersion"],
        "model": spec["model"], "modelRevision": spec["modelRevision"],
        "device": "cpu", "asrUsed": False, "python": sys.executable,
        "modelDirectory": str(runtime / "model"),
        "packages": {name: importlib.metadata.version(name) for name in spec["packages"]},
    }
    if args.write_ready:
        temporary = runtime / f"ready.{os.getpid()}.tmp"
        temporary.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        temporary.replace(runtime / "ready.json")
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"English alignment runtime is not ready: {error}", file=sys.stderr)
        sys.exit(1)
