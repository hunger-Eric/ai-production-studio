"""Bind frozen narration text to word timestamps from the final TTS audio."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from bisect import bisect_left
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Mapping, Sequence


BREAKS = frozenset("，。！？；、,.!?;:")
STRONG_BREAKS = frozenset("。！？.!?")
MAX_TRAILING_SILENCE_MS = 1500


def normal_chars(text: str) -> list[str]:
    return [char.lower() for char in text if char.isalnum()]


def exact_occurrence_count(value: str, needle: str) -> int:
    if not needle:
        return 0
    count, offset = 0, 0
    while offset <= len(value) - len(needle):
        index = value.find(needle, offset)
        if index < 0:
            break
        count += 1
        offset = index + 1
    return count


def caption_chunks(script: str, max_chars: int = 18) -> list[str]:
    chunks: list[str] = []
    buffer = ""
    visible = 0
    for char in script:
        if char.isalnum() and visible >= max_chars and buffer:
            previous = buffer[-1]
            inside_ascii_word = char.isascii() and previous.isascii() and (
                char.isalnum() and (previous.isalnum() or previous in ".-_")
            )
            if not inside_ascii_word:
                chunks.append(buffer)
                buffer = ""
                visible = 0
        buffer += char
        if char.isalnum():
            visible += 1
        decimal_point = char == "." and len(buffer) > 1 and buffer[-2].isdigit()
        if not decimal_point and (
            char in STRONG_BREAKS or (char in BREAKS and visible >= max_chars // 2)
        ):
            chunks.append(buffer)
            buffer = ""
            visible = 0
    if buffer:
        chunks.append(buffer)
    return [chunk for chunk in chunks if normal_chars(chunk)]


def merge_orphan_chunks(chunks: Sequence[str], max_chars: int = 32) -> list[str]:
    """Merge one/two-character caption fragments without changing narration order."""
    merged = list(chunks)
    index = 0
    while index < len(merged):
        if len(normal_chars(merged[index])) > 2 or len(merged) == 1:
            index += 1
            continue
        if index > 0 and len(normal_chars(merged[index - 1] + merged[index])) <= max_chars:
            merged[index - 1] += merged.pop(index)
            continue
        if index + 1 < len(merged) and len(normal_chars(merged[index] + merged[index + 1])) <= max_chars:
            merged[index:index + 2] = [merged[index] + merged[index + 1]]
            continue
        raise ValueError("caption orphan fragment cannot be merged within the subtitle limit")
    return merged


def merge_trigger_chunks(script: str, chunks: Sequence[str], trigger_texts: Sequence[str],
                         max_chars: int = 32) -> list[str]:
    """Keep each frozen motion trigger inside one same-beat subtitle phrase."""
    original = list(chunks)
    if "".join(original) != script:
        raise ValueError("caption segmentation did not preserve frozen narration")
    boundaries: set[int] = {0, len(script)}
    cursor = 0
    for chunk in original:
        cursor += len(chunk)
        boundaries.add(cursor)
    protected_ranges: list[tuple[int, int]] = []
    for trigger_text in trigger_texts:
        if exact_occurrence_count(script, trigger_text) != 1:
            continue
        trigger_start = script.index(trigger_text)
        trigger_end = trigger_start + len(trigger_text)
        if any(trigger_start < boundary < trigger_end for boundary in boundaries):
            protected_ranges.append((trigger_start, trigger_end))
    protected_ranges.sort()
    combined_ranges: list[tuple[int, int]] = []
    for start, end in protected_ranges:
        if combined_ranges and start < combined_ranges[-1][1]:
            combined_ranges[-1] = (combined_ranges[-1][0], max(end, combined_ranges[-1][1]))
        else:
            combined_ranges.append((start, end))
    for start, end in combined_ranges:
        if len(normal_chars(script[start:end])) > max_chars:
            raise ValueError("motion trigger cannot fit one subtitle phrase within the subtitle limit")
        boundaries = {boundary for boundary in boundaries if not start < boundary < end}
        boundaries.update((start, end))
    ordered = sorted(boundaries)
    merged = merge_orphan_chunks(
        [script[ordered[index]:ordered[index + 1]] for index in range(len(ordered) - 1)]
    )
    if any(len(normal_chars(chunk)) > max_chars for chunk in merged):
        raise ValueError("motion trigger cannot fit one subtitle phrase within the subtitle limit")
    return merged


def word_rows(transcript: Mapping[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for segment in transcript.get("segments") or []:
        for word in segment.get("words") or []:
            chars = normal_chars(str(word.get("word") or ""))
            if not chars:
                continue
            start, end = float(word["start"]), float(word["end"])
            if start < 0 or end < start:
                raise ValueError("transcript contains invalid word timestamps")
            rows.append({"chars": chars, "start": start, "end": end,
                         "probability": float(word.get("probability", 0.0))})
    if not rows:
        raise ValueError("transcript contains no word timestamps")
    return rows


def timed_chars(rows: Sequence[Mapping[str, Any]]) -> tuple[list[str], list[tuple[float, float, float]]]:
    chars: list[str] = []
    timings: list[tuple[float, float, float]] = []
    for row in rows:
        word_chars = list(row["chars"])
        start, end = float(row["start"]), float(row["end"])
        duration = max(end - start, 0.001)
        for index, char in enumerate(word_chars):
            chars.append(char)
            timings.append((start + duration * index / len(word_chars),
                            start + duration * (index + 1) / len(word_chars),
                            float(row["probability"])))
    return chars, timings


def reference_timings(reference: Sequence[str], recognized: Sequence[str], timings: Sequence[tuple[float, float, float]]) -> tuple[list[tuple[float, float, float]], list[bool], float, float, int]:
    mapping: dict[int, int] = {}
    for block in SequenceMatcher(None, reference, recognized, autojunk=False).get_matching_blocks():
        for offset in range(block.size):
            mapping[block.a + offset] = block.b + offset
    coverage = len(mapping) / len(reference)
    length_ratio = len(recognized) / len(reference)
    # Whisper commonly emits Traditional Chinese for Simplified Chinese audio.
    # Exact character matching still provides dense acoustic anchors, but the
    # old 0.72 threshold rejects otherwise faithful zh transcripts. A real
    # Grok-TTS rehearsal measured 0.579 with content preserved end-to-end.
    if coverage < 0.55:
        raise ValueError(f"audio transcript coverage is too low: {coverage:.3f}")
    if length_ratio < 0.85 or length_ratio > 1.15:
        raise ValueError(f"audio transcript length ratio is invalid: {length_ratio:.3f}")
    longest_unmatched_run = 0
    current_unmatched_run = 0
    for index in range(len(reference)):
        current_unmatched_run = 0 if index in mapping else current_unmatched_run + 1
        longest_unmatched_run = max(longest_unmatched_run, current_unmatched_run)
    maximum_unmatched_run = max(12, (len(reference) + 4) // 5)
    if longest_unmatched_run > maximum_unmatched_run:
        raise ValueError(f"audio transcript has a truncated or replaced run: {longest_unmatched_run}>{maximum_unmatched_run}")
    anchors = sorted(mapping)
    result: list[tuple[float, float, float]] = []
    matched: list[bool] = []
    for index in range(len(reference)):
        if index in mapping:
            result.append(timings[mapping[index]])
            matched.append(True)
            continue
        insertion = bisect_left(anchors, index)
        previous = anchors[insertion - 1] if insertion else None
        following = anchors[insertion] if insertion < len(anchors) else None
        if previous is None:
            point = timings[mapping[following]][0]
        elif following is None:
            point = timings[mapping[previous]][1]
        else:
            left, right = timings[mapping[previous]][1], timings[mapping[following]][0]
            point = left + max(0.0, right - left) * (index - previous) / (following - previous)
        result.append((point, point, 0.0))
        matched.append(False)
    return result, matched, coverage, length_ratio, longest_unmatched_run


def build_alignment(plan: Mapping[str, Any], transcript: Mapping[str, Any], audio: Path,
                    duration_ms: int, model: str) -> dict[str, Any]:
    beats = plan.get("beats") or []
    raw_triggers = plan.get("motion_triggers") or []
    if not isinstance(raw_triggers, list):
        raise ValueError("motion_triggers must be a list")
    trigger_texts_by_beat: dict[str, list[str]] = {}
    for raw_trigger in raw_triggers:
        if isinstance(raw_trigger, Mapping):
            trigger_texts_by_beat.setdefault(str(raw_trigger.get("beat_id") or ""), []).append(
                str(raw_trigger.get("trigger_text") or "")
            )
    script = "".join(str(beat.get("narration") or "") for beat in beats)
    reference = normal_chars(script)
    if not reference:
        raise ValueError("frozen narration has no alignable text")
    rows = word_rows(transcript)
    recognized, recognized_timings = timed_chars(rows)
    ref_timings, matched, coverage, length_ratio, longest_unmatched_run = reference_timings(reference, recognized, recognized_timings)
    captions: list[dict[str, Any]] = []
    beat_offsets: dict[str, int] = {}
    cursor = 0
    for beat in beats:
        beat_id = str(beat.get("beat_id") or "")
        narration = str(beat.get("narration") or "")
        raw_phrases = beat.get("phrases")
        if not beat_id or beat_id in beat_offsets:
            raise ValueError("frozen narration beats require unique non-empty beat ids")
        if not isinstance(raw_phrases, list) or not raw_phrases or any(not isinstance(value, str) or not value for value in raw_phrases):
            raise ValueError("frozen narration beats require model-authored subtitle phrases")
        chunks = [str(value) for value in raw_phrases]
        if "".join(chunks) != narration:
            raise ValueError("model-authored subtitle phrases must exactly preserve frozen beat narration")
        # Whitespace has no acoustic timestamp. Preserve it on an adjacent cue.
        merged: list[str] = []
        leading = ""
        for chunk in chunks:
            if chunk.isspace():
                if merged:
                    merged[-1] += chunk
                else:
                    leading += chunk
            else:
                merged.append(leading + chunk)
                leading = ""
        if leading or not merged:
            raise ValueError("frozen narration beat has no alignable text")
        chunks = merged
        for index in range(len(chunks) - 1):
            left, right = chunks[index][-1], chunks[index + 1][0]
            if left.isascii() and left.isalnum() and right.isascii() and right.isalnum():
                raise ValueError("model-authored phrase boundary cannot split an ASCII word")
        for trigger_text in trigger_texts_by_beat.get(beat_id, []):
            if sum(trigger_text in chunk for chunk in chunks) != 1:
                raise ValueError("motion trigger must fit one exact model-authored phrase")
        beat_offsets[beat_id] = cursor
        for chunk in chunks:
            length = len(normal_chars(chunk))
            chunk_timings = ref_timings[cursor:cursor + length]
            chunk_matches = matched[cursor:cursor + length]
            cursor += length
            start_ms = round(min(row[0] for row in chunk_timings) * 1000)
            end_ms = round(max(row[1] for row in chunk_timings) * 1000)
            if captions:
                start_ms = max(start_ms, captions[-1]["end_ms"])
            if end_ms <= start_ms:
                end_ms = start_ms + 80
            captions.append({"beat_id": str(beat["beat_id"]), "subtitle": chunk,
                             "start_ms": start_ms, "end_ms": end_ms,
                             "confidence": round(sum(chunk_matches) / len(chunk_matches), 4)})
    if cursor != len(reference):
        raise ValueError("caption segmentation did not preserve frozen narration")
    first_word_ms = round(float(rows[0]["start"]) * 1000)
    last_word_ms = round(float(rows[-1]["end"]) * 1000)
    captions[0]["start_ms"] = min(captions[0]["start_ms"], first_word_ms)
    captions[-1]["end_ms"] = max(captions[-1]["end_ms"], last_word_ms)
    tail_delta = duration_ms - last_word_ms
    if first_word_ms > 1000 or tail_delta < -150 or tail_delta > MAX_TRAILING_SILENCE_MS:
        raise ValueError(f"audio transcript coverage window is invalid: first={first_word_ms}ms tail={tail_delta}ms")
    beat_by_id = {str(beat["beat_id"]): beat for beat in beats}
    motion_triggers: list[dict[str, Any]] = []
    cue_ids: set[str] = set()
    previous_start_ms = -1
    for raw_trigger in raw_triggers:
        if not isinstance(raw_trigger, Mapping):
            raise ValueError("motion trigger specification is invalid")
        cue_id = str(raw_trigger.get("cue_id") or "")
        beat_id = str(raw_trigger.get("beat_id") or "")
        target = str(raw_trigger.get("target") or "")
        trigger_text = str(raw_trigger.get("trigger_text") or "")
        beat = beat_by_id.get(beat_id)
        narration = str(beat.get("narration") or "") if beat else ""
        if not cue_id or cue_id in cue_ids or not beat or not target or exact_occurrence_count(narration, trigger_text) != 1:
            raise ValueError("motion trigger must bind one unique exact same-beat narration substring")
        raw_index = narration.index(trigger_text)
        normalized_start = beat_offsets[beat_id] + len(normal_chars(narration[:raw_index]))
        normalized_length = len(normal_chars(trigger_text))
        trigger_timings = ref_timings[normalized_start:normalized_start + normalized_length]
        if not normalized_length or len(trigger_timings) != normalized_length:
            raise ValueError("motion trigger has no complete final-audio character timing")
        subtitle_indexes = [index for index, caption in enumerate(captions)
                            if caption["beat_id"] == beat_id and trigger_text in caption["subtitle"]]
        if len(subtitle_indexes) != 1:
            raise ValueError("motion trigger must fit one exact same-beat subtitle phrase")
        subtitle_index = subtitle_indexes[0]
        subtitle = captions[subtitle_index]
        start_ms = max(subtitle["start_ms"], round(min(row[0] for row in trigger_timings) * 1000))
        end_ms = min(subtitle["end_ms"], round(max(row[1] for row in trigger_timings) * 1000))
        if end_ms <= start_ms:
            end_ms = min(subtitle["end_ms"], start_ms + 80)
        if start_ms < previous_start_ms or end_ms <= start_ms:
            raise ValueError("motion trigger final-audio timing is invalid or out of narration order")
        motion_triggers.append({"cue_id": cue_id, "beat_id": beat_id, "target": target,
                                "trigger_text": trigger_text, "start_ms": start_ms,
                                "end_ms": end_ms, "subtitle_index": subtitle_index})
        cue_ids.add(cue_id)
        previous_start_ms = start_ms
    return {
        "schema_version": "final_audio_word_alignment.v1",
        "method": "whisper_final_audio_word_alignment",
        "authority": {"text": "frozen_final_narration", "timing": "final_audio_word_alignment"},
        "audio": {"sha256": hashlib.sha256(audio.read_bytes()).hexdigest(), "duration_ms": duration_ms},
        "script": {"sha256": hashlib.sha256(script.encode("utf-8")).hexdigest()},
        "transcriber": {"tool": "openai-whisper", "model": model},
        "metrics": {"alignment_coverage": round(coverage, 4), "transcript_length_ratio": round(length_ratio, 4),
                    "longest_unmatched_character_run": longest_unmatched_run, "first_word_start_ms": first_word_ms,
                    "last_word_end_ms": last_word_ms, "audio_tail_delta_ms": tail_delta,
                    "caption_count": len(captions), "motion_trigger_count": len(motion_triggers)},
        "cues": captions,
        "motion_triggers": motion_triggers,
    }


def plan_from_subtitle_artifact(payload: Mapping[str, Any]) -> dict[str, Any]:
    artifact_payload = payload.get("payload")
    if not isinstance(artifact_payload, Mapping):
        raise ValueError("subtitle artifact payload is missing")
    alignments = artifact_payload.get("alignments")
    if not isinstance(alignments, list) or not alignments:
        raise ValueError("subtitle artifact contains no alignments")
    beats: list[dict[str, Any]] = []
    closed_beat_ids: set[str] = set()
    for row in alignments:
        if not isinstance(row, Mapping):
            raise ValueError("subtitle artifact alignment is invalid")
        beat_id = str(row.get("beat_id") or "").strip()
        narration = str(row.get("narration") or "")
        subtitle = str(row.get("subtitle") or "")
        if not beat_id or not narration or subtitle != narration:
            raise ValueError("subtitle artifact alignment lacks an exact beat phrase")
        if beats and beats[-1]["beat_id"] == beat_id:
            beats[-1]["narration"] += narration
            beats[-1]["phrases"].append(subtitle)
            continue
        if beat_id in closed_beat_ids:
            raise ValueError("subtitle artifact beat alignments are not contiguous")
        if beats:
            closed_beat_ids.add(beats[-1]["beat_id"])
        beats.append({"beat_id": beat_id, "narration": narration, "phrases": [subtitle]})
    return {"beats": beats}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", type=Path, required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--plan", type=Path)
    source.add_argument("--subtitle-artifact", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--duration-ms", type=int, required=True)
    parser.add_argument("--model", default="base")
    parser.add_argument("--model-file", type=Path)
    args = parser.parse_args()
    # This Anaconda installation loads two OpenMP runtimes unless import-time
    # duplicate detection is relaxed. Whisper inference itself remains local.
    os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
    import whisper
    if args.model_file is not None:
        import torch
        torch.set_num_threads(min(6, os.cpu_count() or 1))

    model_options = {}
    if os.environ.get("VIDEO_WHISPER_DEVICE"):
        model_options = {"device": os.environ["VIDEO_WHISPER_DEVICE"],
                         "download_root": os.environ["VIDEO_WHISPER_MODEL_DIR"]}
    if args.model_file is not None:
        if not args.model_file.is_file():
            raise ValueError("local Whisper model file is missing")
        model_options = {"device": "cpu"}
    transcript = whisper.load_model(str(args.model_file) if args.model_file else args.model, **model_options).transcribe(
        str(args.audio), language="zh", word_timestamps=True, verbose=False, fp16=args.model_file is None
    )
    if args.plan is not None:
        plan = json.loads(args.plan.read_text(encoding="utf-8"))
    else:
        artifact = json.loads(args.subtitle_artifact.read_text(encoding="utf-8"))
        plan = plan_from_subtitle_artifact(artifact)
    result = build_alignment(plan, transcript, args.audio, args.duration_ms, args.model)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": "pass", "caption_count": len(result["cues"]),
                      "coverage": result["metrics"]["alignment_coverage"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
