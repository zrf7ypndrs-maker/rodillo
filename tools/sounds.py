"""Renders sounds/tap-{navigate,click,back}.wav: the tap sounds on the home screens (js/sound.js), the "Tick" set
Agustin picked on Nov 26, 2026 (take 3: Tick, Key, Switch; it replaced the earlier "Haptic" pops). A watch-crown /
trackpad tick: a band-passed noise burst plus a 2 to 4 ms resonance, no tone. 48 kHz, mono, 16-bit, seed 23.
  python3 tools/sounds.py            (needs numpy and scipy)
All the styles and their history: claude/rodillo-sounds.md in the claude.ai Rodillo project."""
import numpy as np
from scipy.signal import butter, sosfilt
from scipy.io import wavfile
import json, os, sys

SR = 48000
rng = np.random.default_rng(23)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'sounds')
os.makedirs(OUT, exist_ok=True)

def n_of(ms): return int(SR * ms / 1000)
def t_of(n): return np.arange(n) / SR

def env(n, attack_ms, decay_ms):
    t = t_of(n); a = max(attack_ms / 1000, 1 / SR)
    return np.where(t < a, t / a, np.exp(-(t - a) / (decay_ms / 1000)))

def band(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, min(hi, SR / 2 - 200)], 'bandpass', fs=SR, output='sos'), x)

def burst(ms, lo, hi, decay_ms, amp=1.0, attack_ms=0.05):
    """A noise burst through a band: the contact itself."""
    n = n_of(ms)
    s = band(rng.standard_normal(n), lo, hi)
    return amp * s / (np.abs(s).max() + 1e-9) * env(n, attack_ms, decay_ms)

def ring(ms, f, q, decay_ms, amp=1.0):
    """A very short resonance (the 'material' of the click): an impulse through a narrow band."""
    n = n_of(ms); x = np.zeros(n); x[0] = 1.0; x[1] = -0.6
    s = band(x, f / (1 + 0.5 / q), f * (1 + 0.5 / q))
    s *= env(n, 0.02, decay_ms)
    return amp * s / (np.abs(s).max() + 1e-9)

def mix(ms, *parts):
    out = np.zeros(n_of(ms))
    for off, s in parts:
        i = n_of(off); e = min(len(out), i + len(s)); out[i:e] += s[: e - i]
    return out

def finish(x, peak_db, hp=600):
    x = sosfilt(butter(2, hp, 'highpass', fs=SR, output='sos'), x)
    thr = np.abs(x).max() * 10 ** (-56 / 20)
    x = x[: np.nonzero(np.abs(x) > thr)[0][-1] + 1]
    f = min(n_of(3), len(x) // 3); x[-f:] *= np.linspace(1, 0, f) ** 2
    return x * 10 ** (peak_db / 20) / np.abs(x).max()

S = {}
# ---- Tick (recommended): a watch crown detent / trackpad tick. Tiny, dry, high.
S['tick-navigate'] = finish(mix(20, (0, burst(20, 4000, 11000, 0.7, 1.0)), (0, ring(20, 5200, 8, 2.0, 0.5))), -27, hp=2500)
S['tick-click'] = finish(mix(25, (0, burst(25, 2500, 10000, 0.9, 1.0)), (0, ring(25, 3300, 9, 3.2, 0.8))), -19, hp=1200)
S['tick-back'] = finish(mix(25, (0, burst(25, 1800, 8000, 0.9, 0.9)), (0, ring(25, 2200, 9, 3.6, 0.8))), -21, hp=900)


for k, v in S.items():
    pcm = np.clip(np.round(v * 32767), -32768, 32767).astype(np.int16)
    name = k.replace('tick-', 'tap-')
    wavfile.write(os.path.join(OUT, f'{name}.wav'), SR, pcm)
    print(f'{name}.wav: {len(v) / SR * 1000:.0f} ms, peak {20 * np.log10(np.abs(v).max()):.1f} dBFS')
