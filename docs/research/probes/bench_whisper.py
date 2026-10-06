"""Benchmark faster-whisper large-v3-turbo on RTX 5090: latency, WER under noise/overlap, hallucination on non-speech.

Usage: python bench_whisper.py <model_dir> <testset.npz> <out_json>
"""
import sys, json, time, re, statistics
import numpy as np
from faster_whisper import WhisperModel
import jiwer

model_dir, npz_path, out_json = sys.argv[1], sys.argv[2], sys.argv[3]
data = np.load(npz_path)
meta = json.load(open(npz_path + ".json", encoding="utf-8"))

def norm(s):
    s = s.lower()
    s = s.replace("can't", "cannot").replace("i'm", "i am").replace("it's", "it is")
    s = re.sub(r"[^a-z0-9' ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()

def run(model, audio, **kw):
    t0 = time.perf_counter()
    segs, info = model.transcribe(audio, **kw)
    segs = list(segs)
    dt = (time.perf_counter() - t0) * 1000
    text = " ".join(s.text.strip() for s in segs).strip()
    return text, segs, info, dt

def pct(v, p):
    v = sorted(v)
    k = (len(v) - 1) * p
    lo, hi = int(np.floor(k)), int(np.ceil(k))
    return v[lo] + (v[hi] - v[lo]) * (k - lo)

results = {}
base_kw = dict(beam_size=1, without_timestamps=True, condition_on_previous_text=False, temperature=0.0)

for compute_type in ["float16", "int8_float16"]:
    t_load = time.perf_counter()
    model = WhisperModel(model_dir, device="cuda", compute_type=compute_type)
    load_ms = (time.perf_counter() - t_load) * 1000
    R = {"load_ms": load_ms}
    clean_items = meta["conds"]["clean"]
    clean_audio = [data[f"c__clean__{i}"] for i in range(len(clean_items))]
    # warm-up
    for a in clean_audio[:3]:
        run(model, a, language="en", **base_kw)

    # latency: language fixed vs auto-detect, greedy vs beam 5
    for label, kw in [
        ("lang_en_greedy", dict(language="en", **base_kw)),
        ("lang_auto_greedy", dict(language=None, **base_kw)),
        ("lang_en_beam5", dict(language="en", **{**base_kw, "beam_size": 5})),
        ("lang_en_greedy_vad", dict(language="en", vad_filter=True, **base_kw)),
    ]:
        lat, hyp, ref = [], [], []
        for (name, txt), a in zip(clean_items, clean_audio):
            text, segs, info, dt = run(model, a, **kw)
            lat.append(dt)
            hyp.append(norm(text))
            ref.append(norm(txt))
        dur = [len(a) / 16000 for a in clean_audio]
        R[f"latency_{label}"] = {
            "median_ms": round(statistics.median(lat), 1),
            "p95_ms": round(pct(lat, 0.95), 1),
            "min_ms": round(min(lat), 1),
            "max_ms": round(max(lat), 1),
            "clip_s_median": round(statistics.median(dur), 2),
            "wer_clean": round(jiwer.wer(ref, hyp), 4),
        }

    # WER per condition (language fixed, greedy, no VAD)
    wer = {}
    seg_stats = []
    for cond, items in meta["conds"].items():
        hyp, ref = [], []
        for i, (name, txt) in enumerate(items):
            a = data[f"c__{cond}__{i}"]
            text, segs, info, dt = run(model, a, language="en", **base_kw)
            hyp.append(norm(text))
            ref.append(norm(txt))
            for s in segs:
                seg_stats.append({"cond": cond, "no_speech_prob": s.no_speech_prob, "avg_logprob": s.avg_logprob,
                                  "compression_ratio": s.compression_ratio})
        wer[cond] = {"wer": round(jiwer.wer(ref, hyp), 4),
                     "sent_err_rate": round(sum(h != r for h, r in zip(hyp, ref)) / len(ref), 3),
                     "examples": [(r, h) for r, h in zip(ref, hyp) if r != h][:4]}
    R["wer"] = wer

    # hallucination on non-speech (expected empty)
    halluc = {}
    ns = meta["nonspeech"]
    for label, kw in [
        ("defaults_lang_en", dict(language="en", **base_kw)),
        ("defaults_lang_auto", dict(language=None, **base_kw)),
        ("vad_on_lang_en", dict(language="en", vad_filter=True, **base_kw)),
        ("hotwords_lang_en", dict(language="en", hotwords="ghost, spirit box, flashlight, crowbar, generator, attic, basement", **base_kw)),
        ("hotwords_vad_on", dict(language="en", vad_filter=True, hotwords="ghost, spirit box, flashlight, crowbar, generator, attic, basement", **base_kw)),
    ]:
        outs = []
        for i, kind in enumerate(ns):
            a = data[f"n__{i}"]
            text, segs, info, dt = run(model, a, **kw)
            outs.append({"kind": kind, "text": text,
                         "segs": [{"t": s.text, "nsp": round(s.no_speech_prob, 3), "lp": round(s.avg_logprob, 3), "cr": round(s.compression_ratio, 2)} for s in segs]})
        n_any = sum(1 for o in outs if o["text"])
        # post-filter variants: drop segment if nsp>th_nsp or lp<th_lp
        def post(th_nsp, th_lp):
            c = 0
            for o in outs:
                keep = [s for s in o["segs"] if not (s["nsp"] > th_nsp or s["lp"] < th_lp)]
                if any(s["t"].strip() for s in keep):
                    c += 1
            return c
        halluc[label] = {
            "clips": len(outs),
            "nonempty_raw": n_any,
            "nonempty_post_nsp0.6_or_lp-1.0": post(0.6, -1.0),
            "nonempty_post_nsp0.5_or_lp-0.8": post(0.5, -0.8),
            "nonempty_post_nsp0.3_or_lp-0.6": post(0.3, -0.6),
            "texts": sorted({o["text"] for o in outs if o["text"]})[:15],
            "by_kind_nonempty": {k: sum(1 for o in outs if o["kind"] == k and o["text"]) for k in sorted(set(ns))},
        }
    R["hallucination"] = halluc

    # How do the same post-filters treat REAL speech (false rejections)?
    def false_reject(th_nsp, th_lp, cond):
        rej = 0; tot = 0
        for s in seg_stats:
            if s["cond"] != cond:
                continue
            tot += 1
            if s["no_speech_prob"] > th_nsp or s["avg_logprob"] < th_lp:
                rej += 1
        return f"{rej}/{tot}"
    R["speech_segments_rejected_by_postfilter"] = {
        cond: {"nsp0.6_or_lp-1.0": false_reject(0.6, -1.0, cond),
               "nsp0.5_or_lp-0.8": false_reject(0.5, -0.8, cond),
               "nsp0.3_or_lp-0.6": false_reject(0.3, -0.6, cond)}
        for cond in meta["conds"]
    }
    R["speech_seg_stats_quantiles"] = {
        "no_speech_prob_p50": round(float(np.median([s["no_speech_prob"] for s in seg_stats])), 4),
        "no_speech_prob_p95": round(float(pct([s["no_speech_prob"] for s in seg_stats], 0.95)), 4),
        "avg_logprob_p05": round(float(pct([s["avg_logprob"] for s in seg_stats], 0.05)), 4),
        "avg_logprob_p50": round(float(np.median([s["avg_logprob"] for s in seg_stats])), 4),
    }
    results[compute_type] = R
    del model

with open(out_json, "w", encoding="utf-8") as f:
    json.dump(results, f, indent=1)
print(json.dumps(results, indent=1)[:20000])
