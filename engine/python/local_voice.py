"""Local CUDA Qwen voice worker. The caller supplies the approved text and workspace profile."""
import hashlib
import json
import os
from pathlib import Path
import sys
import time

os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")

def offline(event, _arguments):
    if event == "socket.connect":
        raise RuntimeError("Voice generation must run offline")

sys.addaudithook(offline)

import numpy as np
import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    job_path = Path(sys.argv[1]).resolve()
    job = json.loads(job_path.read_text(encoding="utf-8"))
    profile_path = Path(job["profile"])
    if job.get("profileSha256") and digest(profile_path) != job["profileSha256"]:
        raise ValueError("Voice profile changed after the job was frozen")
    profile = json.loads(profile_path.read_text(encoding="utf-8"))
    reference = Path(profile["reference"])
    if digest(reference) != profile["referenceSha256"]:
        raise ValueError("Voice reference checksum mismatch")
    model_path = Path(profile["modelDirectory"])
    for relative, expected in profile["weights"].items():
        if digest(model_path / relative) != expected:
            raise ValueError("Qwen weight checksum mismatch")
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise RuntimeError("CUDA GPU with BF16 support required for this profile")
    torch.set_num_threads(6)
    torch.set_num_interop_threads(1)
    torch.cuda.reset_peak_memory_stats()
    model = Qwen3TTSModel.from_pretrained(
        str(model_path), device_map="cuda:0", dtype=torch.bfloat16,
        attn_implementation="sdpa", local_files_only=True,
    )
    if next(model.model.parameters()).device.type != "cuda":
        raise RuntimeError("The Qwen model did not load on CUDA")
    prompt = model.create_voice_clone_prompt(ref_audio=str(reference), ref_text=profile["referenceText"])
    codec = model.model.speech_tokenizer
    codec.model.to(device="cpu", dtype=torch.float32)
    codec.device = torch.device("cpu")
    torch.cuda.empty_cache()
    print("CUDA voice ready", flush=True)
    records = []
    for i, text in enumerate(job["parts"]):
        audio_path = job_path.parent / f"part-{i+1:02}.wav"
        evidence_path = audio_path.with_suffix(".json")
        if evidence_path.exists():
            saved = json.loads(evidence_path.read_text(encoding="utf-8"))
            if saved["text"] != text or saved["sha256"] != digest(audio_path) or saved["profileSha256"] != digest(profile_path):
                raise ValueError("Existing voice part does not match the job")
            records.append(saved)
            continue
        if audio_path.exists():
            raise FileExistsError(audio_path)
        torch.manual_seed(2718 + i)
        started = time.perf_counter()
        with torch.inference_mode():
            waves, sr = model.generate_voice_clone(
                text=text, language="Chinese", voice_clone_prompt=prompt,
                non_streaming_mode=True, max_new_tokens=290,
            )
        torch.cuda.synchronize()
        wave = waves[0]
        if sr != 24000 or not np.isfinite(wave).all() or not .8 < len(wave) / sr < 24:
            raise ValueError(f"Unexpected model audio in part {i+1}")
        with audio_path.open("xb") as stream:
            sf.write(stream, wave, sr, format="WAV", subtype="PCM_16")
        row = {"file":audio_path.name, "text":text, "sha256":digest(audio_path),
               "durationSeconds":len(wave)/sr, "seconds":round(time.perf_counter()-started,2),
               "profileSha256":digest(profile_path)}
        with evidence_path.open("x",encoding="utf-8") as stream:
            json.dump(row, stream, ensure_ascii=False, indent=2)
        records.append(row)
        print(f"Part {i+1} generated: {row['durationSeconds']:.2f}s", flush=True)
        torch.cuda.empty_cache()
    result_path = job_path.parent / "voice-result.json"
    result = {"model":"Qwen3-TTS-12Hz-0.6B-Base", "revision":profile["modelRevision"],
              "referenceSha256":profile["referenceSha256"], "profileSha256":digest(profile_path),
              "device":torch.cuda.get_device_name(), "precision":"bf16", "audioCodecDevice":"cpu",
              "peakReservedMiB":round(torch.cuda.max_memory_reserved()/1048576,1), "parts":records}
    with result_path.open("x",encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
