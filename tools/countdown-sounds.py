"""Interval countdown sounds (js/countdown.js), rendered offline: 48 kHz, mono, 16-bit WAV in sounds/.

    python3 tools/countdown-sounds.py            # needs numpy + scipy; deterministic (seeded noise)

Picked with Agustin, Nov 26 (project doc claude/rodillo-countdown-sound.md; audition page of the 20 work sounds:
https://claude.ai/artifact/Ge3TMB9oDxAnoFEY2bisZ2, he took no. 20 with the boom of no. 16, and rest option E2):
  countdown-tick-3/2/1  3, 2, 1 s left, on the interval card's beat: a soft heartbeat-like pulse on G#5 with G#4 under
                        it, swelling in ~15 ms and fading over ~0.6 s like the card's ripple. Each one a bit fuller.
  countdown-work        a work step starts: a 0.14 s air swish that lands on a G#6 ping (G#5 under it) with a soft
                        kick drum. Short: nothing rings after it.
  countdown-rest        a rest step starts (or the workout ends): a softer, darker 0.16 s swish into a slightly lower,
                        rounder boom. No note.
The swish sits at the end of a 0.38 s lead-in, so the ping / boom lands at 0.38 s: on the desktop the file starts with
the Next card's 380 ms slide (slideNextIn in js/ride.js) and the hit lands with the card. With no slide (phone,
reduced motion) the player starts 0.38 s in, right at the hit.
"""
import os
import numpy as np
from scipy.signal import butter, sosfilt
from scipy.io import wavfile

SR = 48000
FLY = 0.38  # s, the desktop slide: the hit lands when the card does
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'sounds')
rng = np.random.default_rng(42)
GS5, GS6 = 830.61, 1661.22


def T(s): return np.arange(int(SR * s)) / SR


def at(out, s, sig):
    i = int(SR * s); e = min(len(out), i + len(sig)); out[i:e] += sig[:e - i]


def fade(x, ms=25):
    f = int(SR * ms / 1000); x[-f:] *= np.linspace(1, 0, f) ** 2; return x


def bp(x, lo, hi): return sosfilt(butter(2, [lo, hi], 'bandpass', fs=SR, output='sos'), x)
def hp(x, fc): return sosfilt(butter(2, fc, 'highpass', fs=SR, output='sos'), x)
def rms(x): return np.sqrt((x ** 2).mean())


def room(x, mix=0.06, ms=120, dk=0.03):
    n = int(SR * ms / 1000)
    ir = rng.standard_normal(n) * np.exp(-np.arange(n) / SR / dk)
    ir = sosfilt(butter(1, 5000, 'lowpass', fs=SR, output='sos'), ir); ir /= np.sqrt((ir ** 2).sum())
    return x + mix * np.convolve(x, ir)[:len(x)]


def sine(f, s, a, d):
    t = T(s); return np.sin(2 * np.pi * f * t) * np.minimum(t / a, 1) * np.exp(-t / d)


def tick(k):
    t = T(0.75)
    ph = 2 * np.pi * np.cumsum(GS5 * (1 + 0.05 * np.exp(-t / 0.025))) / SR  # a slight drop in pitch: the thump
    b = [0.10, 0.16, 0.24][k]
    y = np.sin(ph) + 0.55 * np.sin(ph / 2) + b * np.sin(2 * ph) + b * 0.4 * np.sin(3 * ph) * np.exp(-t / 0.08)
    y *= np.minimum(t / 0.015, 1) ** 2 * np.exp(-np.maximum(t - 0.015, 0) / 0.17)
    return fade(y * [0.8, 0.9, 1.0][k])


def swish(s, lo, hi, shape):
    n = int(SR * s); return bp(rng.standard_normal(n), lo, hi) * np.linspace(0, 1, n) ** shape


def boom(s, amp, f0, dk):
    t = T(s); return amp * np.sin(2 * np.pi * np.cumsum(f0 * (1 + 1.5 * np.exp(-t / 0.02))) / SR) * np.exp(-t / dk)


def work():
    x = np.zeros(int(SR * (FLY + 0.46)))
    at(x, FLY - 0.14, 0.35 * swish(0.14, 1500, 6000, 2))
    at(x, FLY, sine(GS6, 0.45, 0.002, 0.09) + 0.4 * sine(GS5, 0.45, 0.002, 0.08))
    at(x, FLY, boom(0.45, 0.9, 55, 0.07))
    x = hp(room(fade(x)), 40)
    s = int(SR * FLY); x *= 10 ** (-15 / 20) / rms(x[s:s + int(SR * 0.2)])  # as auditioned: hit RMS -15 dBFS
    return x * min(1, 10 ** (-2 / 20) / np.abs(x).max())                    # peak at most -2 dBFS


def rest():
    x = np.zeros(int(SR * (FLY + 0.49)))
    at(x, FLY - 0.16, 0.3 * swish(0.16, 900, 4000, 1.6))
    at(x, FLY, boom(0.5, 0.9, 48, 0.09))
    x = hp(room(fade(x)), 30)
    return x * 10 ** (-4 / 20) / np.abs(x).max()                            # as auditioned: peak -4 dBFS


# ticks as auditioned: the first 0.3 s at -23, -21.8, -20.6 dBFS RMS
ticks = [room(tick(k)) for k in range(3)]
ticks = [x * 10 ** ((-23 + 1.2 * k) / 20) / rms(x[:int(SR * 0.3)]) for k, x in enumerate(ticks)]
sounds = {'countdown-tick-3': ticks[0], 'countdown-tick-2': ticks[1], 'countdown-tick-1': ticks[2],
          'countdown-work': work(), 'countdown-rest': rest()}
os.makedirs(OUT, exist_ok=True)
for name, x in sounds.items():
    last = np.nonzero(np.abs(x) > 10 ** (-70 / 20))[0][-1] + 1  # trim the silent tail
    x = x[:last].copy(); f = min(len(x), int(SR * 0.02)); x[-f:] *= np.linspace(1, 0, f) ** 2
    wavfile.write(os.path.join(OUT, f'{name}.wav'), SR, np.round(x * 32767).astype(np.int16))
    print(f'{name}.wav  {len(x) / SR:.2f} s  peak {20 * np.log10(np.abs(x).max()):.1f} dBFS')
