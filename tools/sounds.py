"""Renders sounds/tap-{navigate,click,back}.wav: the tap sounds on the home screens (js/sound.js), the "Haptic" set
Agustin picked on Nov 26, 2026 (out of Haptic, Liquid and Key). A membrane pop with a tiny contact on top, pitched on
D and A so it sits under the D major title music. 48 kHz, mono, 16-bit. Deterministic (seed 11).
  python3 tools/sounds.py            (needs numpy and scipy)
The audition page with all three styles: claude/rodillo-sounds.md in the claude.ai Rodillo project."""
import numpy as np
from scipy.signal import butter, sosfilt
from scipy.io import wavfile
import json, os, sys

SR = 48000
rng = np.random.default_rng(11)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'sounds')
os.makedirs(OUT, exist_ok=True)
D3, A3, D4, A4, D5, A5, D6, A6 = 146.83, 220.0, 293.66, 440.0, 587.33, 880.0, 1174.66, 1760.0

def n_of(ms): return int(SR * ms / 1000)
def t_of(n): return np.arange(n) / SR

def env(n, attack_ms, decay_ms):
    t = t_of(n); a = max(attack_ms / 1000, 1 / SR)
    return np.where(t < a, (t / a) ** 1.5, np.exp(-(t - a) / (decay_ms / 1000)))

def body(ms, f0, f1, sweep_ms, decay_ms, amp=1.0, attack_ms=0.25):
    """Sine whose pitch glides exponentially from f0 to f1 (membrane / bubble / switch body)."""
    n = n_of(ms); t = t_of(n)
    f = f1 + (f0 - f1) * np.exp(-t / (sweep_ms / 1000))
    return amp * np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, attack_ms, decay_ms)

def tick(ms, center, q, decay_ms, amp=1.0):
    """Band-passed noise burst: the 'contact' of a press."""
    n = n_of(ms)
    lo, hi = center / (1 + 1 / q), min(center * (1 + 1 / q), SR / 2 - 200)
    s = sosfilt(butter(2, [lo, hi], 'bandpass', fs=SR, output='sos'), rng.standard_normal(n))
    return amp * s / (np.abs(s).max() + 1e-9) * env(n, 0.1, decay_ms)

def resonate(x, f, q):
    return sosfilt(butter(2, [f / (1 + 1 / q), f * (1 + 1 / q)], 'bandpass', fs=SR, output='sos'), x)

def mix(ms, *parts):
    out = np.zeros(n_of(ms))
    for off, s in parts:
        i = n_of(off); e = min(len(out), i + len(s)); out[i:e] += s[: e - i]
    return out

def finish(x, peak_db, drive=1.0, hp=120):
    x = sosfilt(butter(2, hp, 'highpass', fs=SR, output='sos'), x)
    if drive > 1: x = np.tanh(drive * x / np.abs(x).max()) / np.tanh(drive)  # density, not distortion
    thr = np.abs(x).max() * 10 ** (-58 / 20)
    x = x[: np.nonzero(np.abs(x) > thr)[0][-1] + 1]
    f = min(n_of(6), len(x) // 3); x[-f:] *= np.linspace(1, 0, f) ** 2
    return x * 10 ** (peak_db / 20) / np.abs(x).max()

S = {}
# ---- Haptic (recommended): the Taptic Engine made audible. A membrane pop with a tiny contact on top.
S['haptic-navigate'] = finish(mix(40, (0, body(40, A5, D5, 2.0, 4.5, 1.0)), (0, tick(40, 3800, 1.6, 1.0, 0.45))), -21, 1.2)
S['haptic-click'] = finish(mix(90, (0, body(90, D5, A3, 6, 11, 1.0)), (0, body(90, D6, A4, 4, 5, 0.22)),
                               (0, tick(90, 4600, 1.4, 1.4, 0.5))), -13, 1.3)
S['haptic-back'] = finish(mix(90, (0, body(90, A4, D3 * 1.5, 7, 10, 1.0)), (0, tick(90, 2600, 1.4, 1.2, 0.3))), -15, 1.3)


for k, v in S.items():
    pcm = np.clip(np.round(v * 32767), -32768, 32767).astype(np.int16)
    name = k.replace('haptic-', 'tap-')
    wavfile.write(os.path.join(OUT, f'{name}.wav'), SR, pcm)
    print(f'{name}.wav: {len(v) / SR * 1000:.0f} ms, peak {20 * np.log10(np.abs(v).max()):.1f} dBFS')
