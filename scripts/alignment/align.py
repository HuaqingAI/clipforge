"""Align known English copy to its actual audio, without running Whisper ASR."""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
import wave


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-dir", required=True, type=Path)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    runtime = args.runtime_dir.resolve()
    os.environ.update({
        "HF_HOME": str(runtime / "hf-cache"), "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1", "NLTK_DATA": str(runtime / "nltk-data"),
        "TOKENIZERS_PARALLELISM": "false",
    })
    started = time.perf_counter()
    import numpy as np
    import torch
    import nltk
    from whisperx.alignment import load_align_model, align

    torch.set_num_threads(min(8, max(1, (os.cpu_count() or 2) // 2)))
    torch.set_num_interop_threads(2)
    nltk.data.path.insert(0, str(runtime / "nltk-data"))
    # No network or automatic model substitution is allowed during composition.
    nltk.data.find("tokenizers/punkt_tab/english/")
    request = json.loads(args.input.read_text(encoding="utf-8-sig"))
    if request.get("schemaVersion") != 1 or not request.get("jobs"):
        raise ValueError("Invalid English alignment request")
    model, metadata = load_align_model("en", "cpu", model_name=str(runtime / "model"), model_cache_only=True)
    result = {"schemaVersion": 1, "model": "facebook/wav2vec2-base-960h",
              "device": "cpu", "asrUsed": False, "jobs": []}
    for job in request["jobs"]:
        tokens = job["text"].split()
        wav_path = Path(job["audioPath"])
        wav_path.parent.mkdir(parents=True, exist_ok=True)
        command = [request["ffmpegPath"], "-v", "error", "-nostdin", "-y",
                   "-i", job["sourcePath"], "-t", str(job["maxDurationSec"]),
                   "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000",
                   "-c:a", "pcm_s16le", str(wav_path)]
        subprocess.run(command, check=True, timeout=120,
                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        with wave.open(str(wav_path), "rb") as stream:
            if stream.getframerate() != 16000 or stream.getnchannels() != 1 or stream.getsampwidth() != 2:
                raise ValueError(f"镜头 {job['id']} 音频格式无效")
            audio = np.frombuffer(stream.readframes(stream.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
        duration = len(audio) / 16000
        if duration < 0.02 or not np.any(np.abs(audio) > 0.0001):
            raise ValueError(f"镜头 {job['id']} 没有可对齐的口播声音")
        aligned = align([{"start": 0.0, "end": duration, "text": job["text"]}],
                        model, metadata, audio, "cpu", interpolate_method="ignore",
                        return_char_alignments=False)
        words = aligned.get("word_segments", [])
        if len(words) != len(tokens) or [word.get("word") for word in words] != tokens:
            raise ValueError(f"镜头 {job['id']} 对齐结果与英文文案不一致，请核对口播和文案")
        timed = []
        for word in words:
            start, end = word.get("start"), word.get("end")
            if start is None or end is None or not math.isfinite(start) or not math.isfinite(end) or end <= start:
                raise ValueError(f"镜头 {job['id']} 的 {word['word']!r} 无法获得真实词时间戳，请核对口播和文案")
            timed.append({"text": word["word"], "startSec": float(start), "endSec": float(end),
                          **({"score": float(word["score"])} if word.get("score") is not None else {})})
        result["jobs"].append({"id": job["id"], "durationSec": duration, "words": timed})
        print(f"Aligned shot {job['id']}: {len(timed)} words", flush=True)
    result["elapsedSec"] = round(time.perf_counter() - started, 3)
    args.output.write_text(json.dumps(result, ensure_ascii=False, allow_nan=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"English audio alignment failed: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
