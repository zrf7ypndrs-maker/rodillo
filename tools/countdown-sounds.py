"""Interval countdown sounds (js/countdown.js), rendered offline: 48 kHz, mono, 16-bit WAV in sounds/.

    python3 tools/countdown-sounds.py            # needs numpy + scipy; deterministic (seeded noise)

What each one is (picked with Agustin, Nov 26; project doc claude/rodillo-countdown-sound.md):
  countdown-tick-3/2/1  3, 2, 1 s left, on the interval card's beat: a soft heartbeat-like pulse on A4 with A3 under
                        it, swelling in ~15 ms and fading over ~0.6 s like the card's ripple. Each one a bit fuller.
  countdown-work        a work step starts: a light rising swish + A major swell for the first 0.38 s (the desktop
                        slide of the Next card onto the interval card), then on landing a bell roll UP the chord
                        (A4, C#5, E5) with a mallet strike, a low A and a soft boom.
  countdown-rest        a rest step starts (or the workout ends): a soft falling swish for 0.38 s, then a reward
                        chime rolling DOWN the chord (E5, C#5, A4) with a faint A5 sparkle.
The GO files keep the 0.38 s lead-in at the front; the player starts them 0.38 s in when there is no slide (phone,
reduced motion), so the hit lands on the card change either way. Peaks are set to the balance Agustin approved in
the Nov 26 demo (PEAK below): the work GO loudest, the rest chime just under it, the ticks well under both.
"""
import os
import numpy as np
from scipy.signal import butter, sosfilt
from scipy.io import wavfile

SR = 48000
FLY = 0.38  # s, the desktop slide (slideNextIn in js/ride.js): the hit lands when the card does
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'sounds')
rng = np.random.default_rng(21)
A3, A4, CS5, E5, A5 = 220.0, 440.0, 554.37, 659.26, 880.0


def T(s): return np.arange(int(SR * s)) / SR


def at(out, s, sig):
    i = int(SR * s); e = min(len(out), i + len(sig)); out[i:e] += sig[:e - i]


def room(x, mix=0.12, ms=220, dk=0.05):
    n = int(SR * ms / 1000)
    ir = rng.standard_normal(n) * np.exp(-np.arange(n) / SR / dk)
    ir = sosfilt(butter(1, 4000, 'lowpass', fs=SR, output='sos'), ir); ir /= np.sqrt((ir ** 2).sum())
    return x + mix * np.convolve(x, ir)[:len(x)]


def level(x, target_db):
    """Room, a 60 Hz high-pass, a short silent tail, then scaled so the first 0.3 s sits at target_db RMS."""
    x = sosfilt(butter(2, 60, 'highpass', fs=SR, output='sos'), room(np.concatenate([x, np.zeros(int(SR * 0.3))])))
    r = 20 * np.log10(np.sqrt((x[:int(SR * 0.3)] ** 2).mean()))
    return x * 10 ** ((target_db - r) / 20)


def tick(f, k):
    t = T(0.75)
    ph = 2 * np.pi * np.cumsum(f * (1 + 0.05 * np.exp(-t / 0.025))) / SR  # a slight drop in pitch: the thump
    bright = [0.10, 0.16, 0.24][k]
    y = np.sin(ph) + 0.55 * np.sin(ph / 2) + bright * np.sin(2 * ph) + bright * 0.4 * np.sin(3 * ph) * np.exp(-t / 0.08)
    y *= np.minimum(t / 0.015, 1) ** 2 * np.exp(-np.maximum(t - 0.015, 0) / 0.17)
    y[-300:] *= np.linspace(1, 0, 300)
    return [0.8, 0.9, 1.0][k] * y


def chime(f, s, amp, dk):
    t = T(s)
    y = (0.7 * np.sin(2 * np.pi * f * 0.9993 * t) + 0.3 * np.sin(2 * np.pi * f * 1.0007 * t)) * np.exp(-t / dk)
    y += 0.22 * np.sin(2 * np.pi * f * 2 * t) * np.exp(-t / (dk * 0.35)) + 0.06 * np.sin(2 * np.pi * f * 3.01 * t) * np.exp(-t / (dk * 0.15))
    y += 0.25 * np.sin(np.pi * f * t) * np.exp(-t / (dk * 0.8))
    y *= np.minimum(t / 0.004, 1); y[-400:] *= np.linspace(1, 0, 400)
    return amp * y


def bellhit(f, s, amp, dk):
    t = T(s)
    return amp * (chime(f, s, 1.0, dk) + 0.35 * np.sin(2 * np.pi * f * 4 * t) * np.exp(-t / 0.012))


def boom(s, amp):
    t = T(s); f = 55 * (1 + 0.8 * np.exp(-t / 0.03))
    return amp * np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.25) * np.minimum(t / 0.003, 1)


def work_hit():
    x = np.zeros(int(SR * 1.3))
    at(x, 0, boom(0.9, 0.35))
    at(x, 0, bellhit(A4, 1.25, 0.30, 0.30))
    at(x, 0.055, bellhit(CS5, 1.2, 0.30, 0.32))
    at(x, 0.11, bellhit(E5, 1.15, 0.36, 0.40))
    at(x, 0.11, bellhit(A3, 1.15, 0.18, 0.35))
    return x


def rest_hit():
    x = np.zeros(int(SR * 1.4))
    at(x, 0, chime(E5, 1.3, 0.21, 0.30))
    at(x, 0.075, chime(CS5, 1.225, 0.21, 0.35))
    at(x, 0.15, chime(A4, 1.15, 0.28, 0.45))
    at(x, 0.15, chime(A5, 1.1, 0.055, 0.25))
    return x


def sweep(s, f0, f1, shape):
    """Noise through a band-pass whose center glides f0 -> f1 (state-variable filter), swelling in."""
    n = int(SR * s); x = rng.standard_normal(n); y = np.zeros(n)
    fc = f0 * (f1 / f0) ** (np.arange(n) / n); low = band = 0.0; q = 1 / 1.6
    for i in range(n):
        f = 2 * np.sin(np.pi * fc[i] / SR); low += f * band; hp = x[i] - low - q * band; band += f * hp; y[i] = band
    return y / np.abs(y).max() * (np.arange(n) / n) ** shape


def swell(freqs, s, shape=3.0):
    t = T(s)
    return sum(a * np.sin(2 * np.pi * f * t) for f, a in freqs) * (t / t[-1]) ** shape


def go(riser, hit, gain):
    out = np.zeros(int(SR * FLY) + len(hit))
    at(out, 0, riser / np.abs(riser).max() * np.abs(hit).max() * gain)
    at(out, FLY, hit)
    return out


ticks = [level(tick(A4, k), -24 + k * 1.2) for k in range(3)]
work = go(sweep(FLY, 900, 2600, 1.6) * 0.18 + swell([(A4, 0.35), (CS5, 0.3), (E5, 0.3)], FLY) * 0.12, level(work_hit(), -15), 0.30)
rest = go(sweep(FLY, 2600, 900, 1.6) * 0.18 + swell([(E5, 0.3), (CS5, 0.3), (A4, 0.35)], FLY) * 0.12, level(rest_hit(), -18), 0.30)

sounds = {'countdown-tick-3': ticks[0], 'countdown-tick-2': ticks[1], 'countdown-tick-1': ticks[2], 'countdown-work': work, 'countdown-rest': rest}
PEAK = {'countdown-tick-3': -8.0, 'countdown-tick-2': -8.2, 'countdown-tick-1': -6.9, 'countdown-work': -1.0, 'countdown-rest': -2.3}  # dBFS
os.makedirs(OUT, exist_ok=True)
for name, x in sounds.items():
    x = x * 10 ** (PEAK[name] / 20) / np.abs(x).max()
    last = np.nonzero(np.abs(x) > 10 ** (-70 / 20))[0][-1] + 1  # trim the silent tail
    x = x[:last]; f = min(len(x), int(SR * 0.02)); x[-f:] *= np.linspace(1, 0, f) ** 2
    wavfile.write(os.path.join(OUT, f'{name}.wav'), SR, np.round(x * 32767).astype(np.int16))
    print(f'{name}.wav  {len(x) / SR:.2f} s  peak {20 * np.log10(np.abs(x).max()):.1f} dBFS')
