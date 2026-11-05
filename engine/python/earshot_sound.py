"""Production bridge: execute pinned upstream kit/score, never author sound decisions."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time


def validate_encoded_master(meter, target=None):
    """Check actual AAC output. Historical runtimes keep their existing peak-only contract."""
    import math
    peak = float(meter["input_tp"])
    if not math.isfinite(peak) or peak > -1:
        raise ValueError("AAC exceeds true-peak headroom")
    if target is None:
        return None
    if target != dict(schema_version="feed_loudness.v1", target_lufs=-14, tolerance_lu=0.5, true_peak_max_dbtp=-1):
        raise ValueError("unknown frozen mastering target")
    loudness = float(meter["input_i"])
    if not math.isfinite(loudness) or abs(loudness - target["target_lufs"]) > target["tolerance_lu"]:
        raise ValueError("encoded whole-film loudness misses the frozen -14 LUFS target")
    return dict(schema_version="feed_mastering_qc.v1", target=target,
                encoded_integrated_lufs=loudness, encoded_true_peak_dbtp=peak, passed=True)


def configure(profile):
    os.environ.pop("EARSHOT_BANK", None)
    os.environ.update(EARSHOT_OFFLINE="1", HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
                      EARSHOT_HOME=profile["model_cache"], EARSHOT_THREADS="3")
    sys.path.insert(0, profile["repository"])


def candidates(spec):
    """Render owner-named alternatives, then expose evidence. Never pick the winner."""
    configure(spec["profile"])
    from earshot import api
    from earshot.forge import bank
    from earshot.report import to_json
    import html
    root = Path(spec["output"])
    root.mkdir(parents=True, exist_ok=True)
    report = dict(schema_version="earshot_candidates.v1", plan_sha256=spec["plan_sha256"],
                  bank=bank.VERSION, catalog=bank.list(), groups=[], hearing="unverified")
    cards = []
    for group in spec["plan"]["groups"]:
        row = dict(id=group["id"], query=group["query"], candidates=[], analysis={})
        paths = []
        for option in group["candidates"]:
            target = root / (group["id"] + "-" + option["id"] + ".wav")
            result = api.sfx_render(option["sound"], str(target), **option.get("edits", {}))
            paths.append(str(target))
            row["candidates"].append(dict(**option, file=target.name, sha256=digest(target), render=result,
                                           measure=api.measure(str(target))))
            cards.append('<p>' + html.escape(group["id"] + ' / ' + option["id"] + ' / ' + option["sound"]) +
                         '</p><audio controls src="' + target.name + '"></audio>')
        # Offline model failures are retained as failures, never replaced by a fabricated rank.
        try:
            row["analysis"]["rank"] = api.rank(paths, group["query"])
            row["analysis"]["ab"] = [api.ab(paths[0], p, query=group["query"]) for p in paths[1:]]
            row["analysis"]["match"] = [api.match(p, group["query"], alts=group.get("alts", [])) for p in paths]
        except Exception as exc:
            row["analysis"]["unavailable"] = type(exc).__name__ + ": " + str(exc)
        report["groups"].append(row)
        (root / "candidates.json").write_text(to_json(report), encoding="utf-8")
    (root / "audition.html").write_text('<meta charset="utf-8"><h1>Owner candidate comparison</h1>' +
        '<p>Unverified hearing. Players use source levels; compare loudness as well as timbre.</p>' + ''.join(cards), encoding="utf-8")


def native_score(spec):
    """Explicit adapter around unchanged Cinetic source: FLOAT stems, separate VO, bank-only voices."""
    configure(spec["profile"])
    sys.path.insert(0, spec["profile"]["cinetic"])
    import score as sc
    import soundfile as sf
    import numpy as np
    root = Path(spec["output"])
    vo, sr = sf.read(root / "supplied-vo.wav", always_2d=True)
    original_write, original_finish = sf.write, sc.M.finish
    def floating_write(file, data, samplerate, *args, **kwargs):
        if Path(file).parent.name == "stems":
            kwargs["subtype"] = "FLOAT"
        return original_write(file, data, samplerate, *args, **kwargs)
    sf.write = floating_write
    def finish_with_vo(mix, *args, **kwargs):
        if mix.shape != vo.shape or sr != sc.SR:
            raise ValueError("native score changed VO timeline")
        premaster = mix + vo
        original_write(root / "premaster.wav", premaster, sr, subtype="FLOAT")
        return original_finish(premaster, *args, **kwargs)
    sc.M.finish = finish_with_vo
    # Earshot permits custom roles; Cinetic's BASE only enumerates its house cue vocabulary.
    # Add bank-owned roles to its existing placement path, retaining take sync and stereo.
    extended = []
    cue_kinds = {e["kind"] for e in spec["cues"]["events"]}
    for role in spec["kit"]["roles"]:
        if role not in sc.BASE and role in cue_kinds:
            sc.BASE[role] = 1.0
            extended.append(role)
    sc.WIDE_KINDS = set(sc.WIDE_KINDS) | set(extended)
    original_lookup, original_pick, original_covers = sc.K.Kit.lookup, sc.K.Kit.pick, sc.K.Kit.covers
    def lookup(self, role):
        result = original_lookup(self, role)
        if result[0] == "missing" and not (role == "bell" and not spec["score"].get("motifs") and not spec["score"].get("progress")):
            raise ValueError("missing bank role; synthesis forbidden: " + role)
        return result
    def pick(self, *args, **kwargs):
        result = original_pick(self, *args, **kwargs)
        if result is None:
            raise ValueError("missing exact bank pitch; synthesis forbidden")
        return result
    sc.K.Kit.lookup, sc.K.Kit.pick = lookup, pick
    def covers(self, *args):
        if not original_covers(self, *args):
            raise ValueError("missing exact bank pitch; synthesis forbidden")
        return True
    sc.K.Kit.covers = covers
    def no_voice(*args, **kwargs):
        raise ValueError("Cinetic synthesis fallback is not authorized")
    sc.S.fm_bell = no_voice  # motif/progress missing-note fallback
    # Save actual placements before score.main reduces them to its report.
    original_render = sc.render
    def render(*args, **kwargs):
        y, info, ev = original_render(*args, **kwargs)
        rows = [{k: v for k, v in p.items() if k != "x"} | {"duration_s": len(p["x"]) / sc.SR}
                for p in ev["placed"]]
        (root / "placements.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
        return y, info, ev
    sc.render = render
    code = sc.main(["--cues", "cues.json", "--score", "audio/score.json", "--out", "soundtrack.wav",
                    "--stems", "stems", "--json", "score-report.json"])
    if code:
        return code
    original_write(root / "stems/vo.wav", vo, sr, subtype="FLOAT")
    premaster, _ = sf.read(root / "premaster.wav")
    reconstructed = sum(sf.read(p)[0] for p in (root / "stems").glob("*.wav"))
    error = float(np.max(np.abs(premaster - reconstructed)))
    (root / "mix-integrity.json").write_text(json.dumps(dict(
        adapter="separate_vo_float_stems.v1", extended_roles=extended, stem_sum_max_error=error,
        premaster_peak=float(np.max(np.abs(premaster))),
        stems={p.name: dict(subtype=sf.info(p).subtype, peak=float(np.max(np.abs(sf.read(p)[0]))))
               for p in (root / "stems").glob("*.wav")},
        vo_max_error=float(np.max(np.abs(sf.read(root / "stems/vo.wav")[0] - vo)))), indent=2), encoding="utf-8")
    if error > 2e-6:
        raise ValueError("actual float stems do not reconstruct master input")
    return code


def digest(p):
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


class RunAudioCache:
    """Run/runtime-scoped, content-addressed successful inputs; corrupt entries fail closed."""
    def __init__(self, root):
        self.root = Path(root) if root else None
        self.rows = []

    def restore(self, key, target):
        if self.root is None:
            return False
        entry = self.root / key
        if not entry.exists():
            return False
        manifest = json.loads((entry / "manifest.json").read_text(encoding="utf-8"))
        if manifest.get("key") != key:
            raise ValueError("audio cache identity changed")
        for item in manifest["files"]:
            rel = Path(item["file"])
            if rel.is_absolute() or ".." in rel.parts or digest(entry / rel) != item["sha256"]:
                raise ValueError("audio cache SHA changed")
        target.mkdir(parents=True, exist_ok=True)
        for item in manifest["files"]:
            dest = target / item["file"]
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(entry / item["file"], dest)
        self.rows.append(dict(key=key, status="reused", files=manifest["files"]))
        return True

    def save(self, key, source):
        if self.root is None:
            return
        entry = self.root / key
        entry.mkdir(parents=True)
        files = []
        for file in source.rglob("*"):
            if not file.is_file():
                continue
            rel = file.relative_to(source)
            dest = entry / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(file, dest)
            files.append(dict(file=rel.as_posix(), sha256=digest(file)))
        (entry / "manifest.json").write_text(json.dumps(dict(key=key, files=files)), encoding="utf-8")
        self.rows.append(dict(key=key, status="created", files=files))


def audit_cues(cues, lock, placements, report):
    """Translate declared take sync points for native QC only, retaining original cues/IDs."""
    audit = json.loads(json.dumps(cues))
    bindings = []
    aliases = {}
    for event in audit["events"]:
        placement = next((p for p in placements if p.get("id") == event["id"]), None)
        if placement is None:  # intentional null / native typing thinning remains in original report
            continue
        role = lock["roles"][placement["role"]]
        take = next(t for t in role["takes"] if t["file"] == placement["sample"])
        anchor = role["align"]
        duration = placement["duration_s"]
        original = dict(event)
        # Native forensics recognises whoosh peaks and riser ends by kind. Custom
        # bank roles need the same classification, not its default onset test.
        if anchor == "peak":
            event.update(kind="whoosh", dur=duration * cues["fps"], apexFrac=take["peak_s"] / duration)
        elif anchor == "end":
            event.pop("apexFrac", None)
            event.update(kind="riser", dur=duration * cues["fps"])
        else:
            event.pop("apexFrac", None)
            if event["kind"] not in ("text", "hit", "bell", "land", "pop", "snap", "tick", "tock", "click", "key"):
                event["kind"] = "bank_contact"
        event["source_kind"] = original["kind"]
        aliases[(original["f"], original["kind"])] = event["kind"]
        bindings.append(dict(id=event["id"], original=original, audit=event, role=placement["role"],
                             sample=placement["sample"], anchor=anchor, sync_seconds=take[anchor + "_s"]))
    audit_report = json.loads(json.dumps(report))
    for event in audit_report["events"]["skipped"]:
        event["kind"] = aliases.get((event["f"], event["kind"]), event["kind"])
    return audit, audit_report, bindings


def analyze(spec):
    """One full local model pass on an existing final candidate; never remixes/re-encodes."""
    configure(spec["profile"])
    root, source = Path(spec["output"]), Path(spec["analysis_source"])
    args = [sys.executable, str(Path(spec["profile"]["cinetic"]) / "listen.py"), "--python", sys.executable,
            "--audio", str(source / "mix.m4a"), "--video", str(source / "audio-check.mp4"),
            "--cues", str(source / "audit-cues.json"), "--json", str(root / "listen.json"), "--out", str(root)]
    env = {**os.environ, "PYTHONPATH": spec["profile"]["repository"], "PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1"}
    start = time.monotonic()
    result = subprocess.run(args, cwd=source, env=env, capture_output=True,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    for name, data in [("stdout", result.stdout), ("stderr", result.stderr)]:
        (root / ("native-listen." + name + ".txt")).write_bytes(data)
    (root / "calls.json").write_text(json.dumps([dict(argv=args, exit_code=result.returncode,
        duration_seconds=time.monotonic()-start, stdout_sha256=digest(root / "native-listen.stdout.txt"),
        stderr_sha256=digest(root / "native-listen.stderr.txt"))]), encoding="utf-8")
    if not (root / "listen.json").exists():
        (root / "listen.json").write_text(json.dumps(dict(listened=False,
            why="native local analysis failed; inspect preserved stdout/stderr", exit_code=result.returncode)), encoding="utf-8")


def main(spec_path):
    spec = json.loads(Path(spec_path).read_text(encoding="utf-8"))
    root = Path(spec["output"])
    root.mkdir(parents=True, exist_ok=True)
    profile = spec["profile"]
    iterative = spec.get("iteration_policy") == "iterate_then_analyze.v1"
    cache = RunAudioCache(spec.get("cache") if iterative else None)
    configure(profile)
    from earshot.forge import bank, kit
    import numpy as np
    import soundfile as sf
    from scipy import signal

    soundkit = spec["kit"]
    entries = {x["id"] for x in bank.list()}
    if soundkit.get("sr") != 48000 or soundkit.get("kit") != 1:
        raise ValueError("kit must use upstream schema 1 / 48kHz")
    for role, voice in soundkit["roles"].items():
        if voice is not None and voice.get("sound") not in entries:
            raise ValueError("only shipped bank entries may be rendered: " + role)
    audio = root / "audio"
    audio.mkdir()
    (root / "stems").mkdir()
    (audio / "kit.json").write_text(json.dumps(soundkit), encoding="utf-8")
    (root / "cues.json").write_text(json.dumps(spec["cues"]), encoding="utf-8")
    kit_key = "kit-" + hashlib.sha256(json.dumps(soundkit, sort_keys=True).encode()).hexdigest()
    if not cache.restore(kit_key, audio / "kit"):
        kit.render(str(audio / "kit.json"), str(audio / "kit"))
        cache.save(kit_key, audio / "kit")
    lock = json.loads((audio / "kit/kit.lock.json").read_text(encoding="utf-8"))
    native = Path(profile["cinetic"])
    module_spec = importlib.util.spec_from_file_location("native_kit", native / "kit.py")
    native_kit = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(native_kit)
    for e in spec["cues"]["events"]:
        role = native_kit.role_for(e["kind"], e.get("variant"), e.get("weight", 1), e.get("dur", 0) / 30 or None)
        if role not in lock["roles"]:
            raise ValueError("cue lacks a bank role: " + str(role))
        if lock["roles"][role] is None and not soundkit.get("off", {}).get(role):
            raise ValueError("deliberately silent role needs its owner reason: " + role)
        decision = next((a for a in spec.get("arrangement", {}).get("effects", []) if a["cue_id"] == e["id"]), None)
        if decision and lock["roles"][role] and lock["roles"][role]["align"] != decision["anchor"]:
            raise ValueError("cue anchor differs from actual bank role before mixing: " + e["id"])

    env = os.environ.copy()
    env.update(PYTHONPATH=profile["repository"], PYTHONDONTWRITEBYTECODE="1", EARSHOT_OFFLINE="1",
               EARSHOT_HOME=profile.get("model_cache", str(root / "cache")), EARSHOT_THREADS="3", PYTHONIOENCODING="utf-8")
    env.pop("EARSHOT_BANK", None)
    calls = []

    def call(args, name, optional=False):
        started = time.monotonic()
        result = subprocess.run([str(x) for x in args], cwd=root, env=env, capture_output=True,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        (root / (name + ".stdout.txt")).write_bytes(result.stdout)
        (root / (name + ".stderr.txt")).write_bytes(result.stderr)
        calls.append(dict(argv=[str(x) for x in args], exit_code=result.returncode,
                          duration_seconds=time.monotonic()-started,
                          stdout_sha256=digest(root / (name + ".stdout.txt")),
                          stderr_sha256=digest(root / (name + ".stderr.txt"))))
        (root / "calls.json").write_text(json.dumps(calls, indent=2), encoding="utf-8")
        if result.returncode and not optional:
            raise RuntimeError(name + " failed; inspect preserved stdout/stderr")

    call([sys.executable, "-m", "earshot", "kit", "check", "audio/kit.json", "--out", "audio/kit", "--json"], "kit-check")
    if any(voice for voice in lock["roles"].values()):
        call([sys.executable, "-m", "earshot", "kit", "audition", "audio/kit.json", "--out", "audio/kit", "-o", "kit-audition.wav"], "kit-audition")
    def decode(source, target):
        key = "decode-" + digest(source)
        if cache.restore(key, target.parent / (target.stem + "-cached")):
            restored = target.parent / (target.stem + "-cached")
            if target.resolve().parent != root.resolve() or restored.resolve().parent != root.resolve():
                raise ValueError("decoded cache target escaped current output")
            shutil.move(str(restored / "decoded.wav"), target)
            restored.rmdir()
            return sf.read(target)[0]
        call(["ffmpeg", "-v", "error", "-i", source, "-ar", "48000", "-ac", "2", "-c:a", "pcm_f32le", target], target.stem)
        if cache.root is not None:
            folder = target.parent / (target.stem + "-cache-input")
            folder.mkdir()
            shutil.copyfile(target, folder / "decoded.wav")
            cache.save(key, folder)
            if folder.resolve().parent != root.resolve():
                raise ValueError("decode cache temporary directory escaped current output")
            shutil.rmtree(folder)
        return sf.read(target)[0]

    n = round(spec["duration_frames"] / 30 * 48000)
    vo_raw = decode(spec["narration"], root / "vo-reference.wav")
    if abs(len(vo_raw) - n) > 7200:
        raise ValueError("VO duration differs from frozen timeline")
    vo = np.pad(vo_raw[:n], ((0, max(0, n-len(vo_raw))), (0, 0))) * 10**(spec["supplied"]["narration_gain_db"] / 20)
    music = np.zeros((n, 2))
    # Cinetic sound.md supplied-VO branch: prepare the supplied input bed first.
    # This is only explicit trim/gain/fade/placement of licensed inputs; all
    # sound design rendering, SFX mixing and final mastering use upstream code.
    for index, segment in enumerate(spec["music"]):
        source = decode(segment["file"], root / ("music-source-%d.wav" % index))
        lo = round(segment["source_start_seconds"] * 48000)
        length = segment["duration_frames"] * 1600
        clip = source[lo:lo+length].copy()
        if len(clip) != length:
            raise ValueError("music trim exceeds actual licensed source; no silent padding/loop")
        clip *= 10**(segment["gain_db"] / 20)
        for count, reverse in [(round(segment["fade_in_seconds"]*48000), False), (round(segment["fade_out_seconds"]*48000), True)]:
            if count:
                ramp = np.linspace(0, 1, count)
                if reverse:
                    clip[-count:] *= ramp[::-1, None]
                else:
                    clip[:count] *= ramp[:, None]
        if segment["envelope"]:
            frames = np.arange(length) / 1600
            points = segment["envelope"]
            clip *= (10**(np.interp(frames, [p["frame"] for p in points], [p["gain_db"] for p in points])/20))[:, None]
        offset = segment["start_frame"] * 1600
        music[offset:offset+length] += clip
    bed = vo + music
    for name, data in [("supplied-vo.wav", vo), ("supplied-music.wav", music), ("supplied-bed.wav", bed)]:
        sf.write(root / name, data, 48000, subtype="FLOAT")
    score = spec["score"].copy()
    # Supplied MUSIC only enters the conductor's bed. VO bypasses its fades/ducks/silences.
    score.update(music="none",
                 sfx=dict(engine="earshot", kit="audio/kit.json", python=sys.executable),
                 bed=dict(file="supplied-music.wav", gain_db=0))
    (audio / "score.json").write_text(json.dumps(score, indent=2), encoding="utf-8")
    call([sys.executable, str(native / "kit.py"), "render", "--kit", "audio/kit.json", "--takes", "audio/kit", "--python", sys.executable], "native-kit")
    call([sys.executable, str(Path(__file__).resolve()), "--native-score", str(Path(spec_path).resolve())], "score")
    report = json.loads((root / "score-report.json").read_text())
    sx = report["sfx"]
    if sx["engine"] != "earshot" or sx["synth"]:
        raise ValueError("all sounded cues must use shipped bank takes; synthesis forbidden")
    for event in report["events"]["skipped"]:
        if event.get("kind") != "key" and "off in the kit" not in event.get("why", ""):
            raise ValueError("unexpected cue skip: " + str(event))

    sfx, sr = sf.read(root / "stems/sfx.wav")
    # Meter real simultaneous material. No automatic gain decision or taste threshold.
    n = len(sfx)
    rows = []
    rms = lambda a: float(np.sqrt(np.mean(a*a))) if len(a) else 0.0
    db = lambda a: float(20*np.log10(max(a, 1e-12)))
    actual_music = sum(sf.read(p)[0] for p in (root / "stems").glob("*.wav") if p.name not in ("vo.wav", "sfx.wav"))
    placements = json.loads((root / "placements.json").read_text())
    for e in placements:
        start = max(0, round(e["start"] * sr))
        stop = min(n, round((e["start"] + e["duration_s"]) * sr))
        # Includes pre-cue motion/end-aligned builds and long tails, unlike a fixed post-cue window.
        a, v = sfx[start:stop], vo[start:stop]
        m = actual_music[start:stop]
        b = v + m
        energy = np.mean(a*a, axis=1)
        strongest = int(np.argmax(np.convolve(energy, np.ones(960)/960, mode="same"))) if len(a) else 0
        lo, hi = max(0, strongest-480), min(len(a), strongest+480)
        rows.append(dict(id=e["id"], frame=e["f"], start_s=start/sr, end_s=stop/sr,
                         sfx_rms_dbfs=db(rms(a)), vo_rms_dbfs=db(rms(v)), bed_rms_dbfs=db(rms(b)),
                         sfx_vs_vo_db=db(rms(a))-db(rms(v)),
                         sfx_vs_music_db=db(rms(a))-db(rms(m)),
                         strongest_20ms_vs_vo_db=db(rms(a[lo:hi]))-db(rms(v[lo:hi]))))
    (root / "relative-levels.json").write_text(json.dumps(dict(
        note="Pre-master actual SFX versus simultaneous VO and licensed music+VO bed; not a hearing verdict.", events=rows), indent=2), encoding="utf-8")
    if spec.get("arrangement"):
        # Verify what the native renderer actually produced, not just the planned JSON.
        plan = spec["arrangement"]
        supplied_music, _ = sf.read(root / "stems/bed.wav")
        gaps, music_rows, anchors = [], [], []
        for gap in plan["music_absence"]:
            clip = supplied_music[gap["from"] * 1600:gap["to"] * 1600]
            peak = float(np.max(np.abs(clip))) if len(clip) else 0.0
            gaps.append(dict(**gap, actual_music_peak=peak))
            if peak > 1e-7:
                raise ValueError("music leaked into an owner-authored music-free interval")
        for segment in spec["music"]:
            lo = segment["start_frame"] * 1600
            hi = lo + segment["duration_frames"] * 1600
            a, b = lo + round(segment["fade_in_seconds"] * sr), hi - round(segment["fade_out_seconds"] * sr)
            if b <= a:
                a, b = lo, hi
            clip = supplied_music[a:b]
            music_rows.append(dict(start_frame=segment["start_frame"], duration_frames=segment["duration_frames"],
                music_rms_dbfs=db(rms(clip)), simultaneous_vo_rms_dbfs=db(rms(vo[a:b])),
                music_vs_vo_db=db(rms(clip))-db(rms(vo[a:b])),
                start_sample_delta=float(np.max(np.abs(supplied_music[lo]-supplied_music[max(0,lo-1)]))),
                end_sample_delta=float(np.max(np.abs(supplied_music[min(n-1,hi)]-supplied_music[hi-1])))))
            if not np.any(supplied_music[lo:hi]):
                raise ValueError("planned music became entirely silent; return to the owner, do not silently omit it")
        for placement in placements:
            decision = next((e for e in plan["effects"] if e["cue_id"] == placement.get("id")), None)
            if decision is None:
                # Native motifs/progress can add derived placements. Report rather than inventing an action reason.
                anchors.append(dict(id=placement.get("id"), status="derived_native_placement"))
                continue
            role = lock["roles"][placement["role"]]
            take = next(t for t in role["takes"] if t["file"] == placement["sample"])
            anchor = decision["anchor"]
            if role["align"] != anchor:
                raise ValueError("native kit sync point differs from the picture action decision")
            error = abs(placement["start"] + take[anchor+"_s"] - decision["frame"]/30) * sr
            anchors.append(dict(id=decision["cue_id"], frame=decision["frame"], anchor=anchor, error_samples=error))
            if error > 1.01:
                raise ValueError("actual SFX placement drifted from the owner picture anchor")
        (root / "arrangement-qc.json").write_text(json.dumps(dict(
            schema_version="earshot_arrangement_qc.v1", hearing="unverified", music_absence=gaps,
            music_segments=music_rows, anchors=anchors, skipped=report["events"]["skipped"],
            native_tonal_stems_peak=float(np.max(np.abs(actual_music-supplied_music))),
            note="Checks silence, levels and sample placement, not semantic truth or subjective listening quality."), indent=2), encoding="utf-8")
    y, _ = sf.read(root / "soundtrack.wav")
    if not np.isfinite(y).all() or np.max(np.abs(y)) >= 1:
        raise ValueError("nonfinite/clipped soundtrack")
    if len(y) != round(spec["duration_frames"] / 30 * 48000):
        raise ValueError("soundtrack changed real narration timeline")
    provenance = []
    for role, voice in lock["roles"].items():
        if not voice:
            continue
        entry = bank.get(voice["sound"])
        for take in voice["takes"]:
            provenance.append(dict(role=role, bank_id=voice["sound"], take=take,
                                   sha256=digest(audio / "kit" / take["file"]), bank_entry=entry))
    (root / "bank-provenance.json").write_text(json.dumps(provenance, indent=2), encoding="utf-8")
    credits = ["# Earshot bank sound provenance", "Earshot 0.3.0: official shipped recipes, not WOOSH/model output or original recordings.",
               "Earshot code license:\n" + (Path(profile["repository"]) / "LICENSE").read_text(),
               "Cinetic code license:\n" + (native / "LICENSE").read_text(),
               "Recipe/fit IDs and exact source metadata: bank-provenance.json. Licensed music credits remain in the original production package."]
    (root / "ATTRIBUTION.md").write_text("\n\n".join(credits), encoding="utf-8")
    call(["ffmpeg", "-v", "error", "-i", "soundtrack.wav", "-c:a", "aac", "-b:a", "192k", "mix.m4a"], "encode")
    call(["ffmpeg", "-v", "error", "-xerror", "-i", "mix.m4a", "-f", "null", "-"], "complete-decode")
    call(["ffmpeg", "-hide_banner", "-i", "mix.m4a", "-af",
          "loudnorm=I=-18:TP=-1:LRA=11:print_format=json", "-f", "null", "-"], "encoded-metrics")
    meter_text = (root / "encoded-metrics.stderr.txt").read_text(encoding="utf-8")
    meter = json.loads(meter_text[meter_text.rfind("{"):meter_text.rfind("}")+1])
    mastering_qc = validate_encoded_master(meter, spec.get("mastering_target"))
    if mastering_qc:
        (root / "mastering-qc.json").write_text(json.dumps(mastering_qc, indent=2), encoding="utf-8")
    # A run-local audio proxy copies the actual rough picture, solely for the
    # upstream sync/AV tools. It never becomes an accepted visual preview.
    call(["ffmpeg", "-v", "error", "-i", spec["rough_cut"], "-i", "mix.m4a",
          "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-t", str(n/48000), "audio-check.mp4"], "audio-proxy")
    call([sys.executable, str(native / "check-sync.py"), "audio-check.mp4", "soundtrack.wav",
          "--json", "sync.json"], "native-sync")
    audit_path, report_path = "cues.json", "score-report.json"
    if iterative:
        audit, audit_report, bindings = audit_cues(spec["cues"], lock, placements, report)
        for name, value in [("audit-cues.json", audit), ("audit-score-report.json", audit_report), ("cue-audit-bindings.json", bindings)]:
            (root / name).write_text(json.dumps(value, indent=2), encoding="utf-8")
        audit_path, report_path = "audit-cues.json", "audit-score-report.json"
    call([sys.executable, str(native / "av-audit.py"), "audio-check.mp4", "--cues", audit_path,
          "--stems", "stems", "--score", "audio/score.json", "--score-report", report_path,
          "--json", "av-audit.json"], "native-av", optional=not iterative or not spec["cues"]["events"])
    if iterative:
        if not spec["cues"]["events"]:
            # Upstream exits before producing a report when there are no events.
            # Preserve that receipt and verify the deliberately empty stem; do not invent cues or a native pass.
            if np.any(sfx):
                raise ValueError("unexpected SFX without authored events")
            event_qc = dict(status="not_applicable", reason="no authored events; native AV has no events to check", sfx_peak=0.0)
        else:
            if not json.loads((root / "av-audit.json").read_text(encoding="utf-8")).get("pass"):
                raise ValueError("native technical AV checks failed; preserve reports and fix before final analysis")
            event_qc = dict(status="passed", report="av-audit.json")
        (root / "event-audit.json").write_text(json.dumps(event_qc), encoding="utf-8")
    # Original local analyses are evidence, never a taste/approval score. They
    # remain optional when a local model is unavailable; no network/LLM fallback.
    if not iterative:
        call([sys.executable, str(native / "listen.py"), "--python", sys.executable,
          "--audio", "mix.m4a", "--video", "audio-check.mp4", "--cues", "cues.json",
          "--json", "listen/listen.json", "--out", "listen"], "native-listen", optional=True)
    if not iterative and not (root / "listen/listen.json").exists():
        (root / "listen").mkdir(exist_ok=True)
        (root / "listen/listen.json").write_text(json.dumps(dict(listened=False, why="native local analysis failed; see original receipts")))
    result = dict(schema_version="earshot_worker_result.v1", status="success", bank=bank.VERSION,
                  kit_cues=sx["kit_cues"], authored_cues=len(spec["cues"]["events"]), output_sha256=digest(root / "mix.m4a"),
                  hearing="unverified", external_model_calls=0, clipped_samples=0,
                  encoded_metrics=meter)
    (root / "result.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    if iterative:
        (root / "cache-receipt.json").write_text(json.dumps(dict(policy=spec["iteration_policy"], entries=cache.rows)), encoding="utf-8")


if __name__ == "__main__":
    if sys.argv[1] == "--native-score":
        sys.exit(native_score(json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))))
    elif sys.argv[1] == "--candidates":
        candidates(json.loads(Path(sys.argv[2]).read_text(encoding="utf-8")))
    elif sys.argv[1] == "--analyze":
        analyze(json.loads(Path(sys.argv[2]).read_text(encoding="utf-8")))
    else:
        main(sys.argv[1])
