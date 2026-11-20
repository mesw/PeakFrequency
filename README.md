# Peak Frequency

A Garmin Connect IQ breath pacer for finding and practicing your cardiovascular resonance breathing frequency.

This is a pet project, not a commercial product, and the goal here is to stick closely to the published physiology rather than generic breathwork claims. The app is free in the [Garmin Connect IQ Store](https://apps.garmin.com/apps/174cda32-a42a-43b4-8b07-658ddda48d92?tid=0). The source code is not open sourced yet.

If you want to read all instructions clearly or try the browser version, have a look at the web version here: https://mesw.github.io/PeakFrequency/

> **Known UI issue:** On some watch screen sizes, parts of the on-screen text can still get cut off. That is a layout bug I have not solved yet—if something is cut off on your watch, the full text and instructions are on the website above.

---

## Why Resonance Breathing Is Different

Most popular breathing exercises use fixed counts or breath holds. Resonance breathing works differently: the goal is to maximize heart rate variability (HRV)—specifically how much your heart rate rises during an inhalation and drops during an exhalation across each breath cycle ($\Delta\text{HR}$, or Respiratory Sinus Arrhythmia, RSA)—by breathing at your individual resonance frequency.

In adults, this resonance usually sits between **4.5 and 6.5 breaths per minute** (around 0.1 Hz). Two physiological mechanisms meet at that pace:

1. **Respiratory Sinus Arrhythmia (RSA):** Heart rate accelerates when you inhale and slows down when you exhale via vagal modulation.
2. **Arterial Baroreflex Loop Delay:** Blood pressure changes take roughly ~5 seconds per half-cycle to travel through the vascular and neural baroreflex feedback loop (Vaschillo et al., 2002; Lehrer & Gevirtz, 2014).

When your breathing period matches that natural loop delay:
- **Heart rate and breathing align near 0° phase synchrony:** heart rate climbs during inhalation, peaks around the end of the inhale, and falls during exhalation (Vaschillo et al., 2004; Shaffer & Meehan, 2020).
- **Heart rate and blood pressure sit near 180° phase opposition:** baroreflex compensation reinforces the respiratory swing instead of fighting it, producing the largest HRV oscillation amplitude.

Your personal resonance frequency can vary slightly depending on posture, stress, and breathing comfort (Vaschillo et al., 2006), and shifting cadence by even 0.5 breaths/min can noticeably reduce amplitude (Vaschillo et al., 2006; Steffen et al., 2017). To measure phase shift and amplitude reliably, we also have to know the exact breathing timing—so the app guides when to inhale, when to exhale, and for how long, while measuring your heart rate response against that reference.

---

## How the App Works (Implementation Details)

### 1. Starting Point from Your Profile
If height and biological sex are set in your Garmin user profile (`UserProfile`), the app calculates a starting cadence with the linear regression formulas from Hasuo et al. (2023/2024), clamped to **4.5–6.5 BPM** and rounded to 0.1 BPM (falling back to 175 cm / male if no profile data is available, or a custom manual anchor between 4.0 and 8.5 BPM):
- **Men:** $\text{RF} = 17.90 - 0.07 \times \text{height (cm)}$ (adjusted $R^2 = 0.55$)
- **Women:** $\text{RF} = 15.88 - 0.06 \times \text{height (cm)}$ (adjusted $R^2 = 0.47$)

Height and sex only explain roughly half of the variance between people, so the app uses this only as a starting estimate and tests around it empirically.

### 2. Two-Round Calibration (`Resonance Test`)
- **Breath ratio:** Every paced cycle uses a continuous **40% inhale / 60% exhale** split with no breath holds.
- **Resting baseline:** Starts with **120 s** of free breathing.
- **Round 1 (±0.25 BPM):** Runs **120 s** paced legs at `center`, `+0.25 BPM`, and `-0.25 BPM`, separated by **120 s** free-breathing rest intervals.
- **Round 2 (±0.125 BPM):** Runs `+0.125 BPM` and `-0.125 BPM` around the Round 1 winner (plus the center reference) using the same 120 s stages and rest intervals, then locks the winning cadence.
- **Scoring:** From each 120 s paced leg, the first ~60 s (first half of cycles) are discarded as physiological settling time. Remaining cycles go through outlier filtering, are resampled onto **25 normalized grid points**, and are averaged into a mean waveform. Each stage is scored as `0.60 * ensembleDeltaHR + 0.40 * meanCycleDeltaHR`, penalized if peak heart rate occurs more than **1200 ms** away from the end of inhalation.

### 3. Daily Practice (`Resonance Training`)
- Selectable session durations of **5, 10, 15, or 20 minutes**, with an optional free-breathing halfway break (**30, 60, 90, or 120 s**) and adjustable cadence (**3.5–7.0 BPM**).
- Computes per-breath $\Delta\text{HR}$, phase synchrony percentage, and a 1 Hz per-breath **Goertzel** spectral purity score at the target breathing frequency.
- Includes a low-power display mode (`onEnterSleep`) to reduce battery use and OLED/AMOLED burn-in during 20-minute sessions.

### 4. Sensors, Filtering, and Privacy
- **HRV chest strap vs. optical HR:** Reads beat-to-beat R–R intervals (`heartBeatIntervals`, 4 s sensor data listener period) when an HRV chest strap is connected; falls back to standard heart rate telemetry if no beat-to-beat stream arrives within 15 s. A chest strap is recommended for calibration because optical wrist sensors smooth or miss fast beat-to-beat changes.
- **Artifact rejection:** R–R intervals outside **300–1500 ms** or differing by more than **20%** from the previous valid beat are rejected (Task Force, 1996; Tarvainen et al., 2014), then passed through a 3-point rolling median filter and exponential smoothing (`0.35 * instant + 0.65 * filtered`).
- **Movement check:** Watches the 3-axis accelerometer (while suppressing vibration motor pulses) and shows `Stay still` if sustained arm/wrist movement is detected.
- **On-device only:** `manifest.xml` declares sensor, user profile, and FIT activity recording permissions—no internet permission. Completed sessions can be saved as standard Garmin `.FIT` training/breathwork activities or discarded.

---

## How to Breathe (The Practical Part)

It takes a bit of practice to calmly breathe at the slow cadence the app shows. It takes practice, **not effort**: just slide into the rhythm.

- **Do not over-inhale or force the exhale.** No forced breathing. Let the air enter slowly into your belly (not your upper chest), and let it out a little slower without pushing.
- **If you feel dizzy or lightheaded,** you are moving too much air (blowing off too much $\text{CO}_2$). Take shallower, quieter breaths.
- **If you feel a hunger for air,** you are overdoing it or tensing up. Relax, ease off the breath depth, or nudge the cadence slightly faster until it feels comfortable.
- **Pick a quiet environment.** This is not meant for a commute or while walking around. It works best lying down in bed or sitting in a comfortable chair where you do not have to move a finger for 20 minutes.

---

## References

1. Lehrer, P. M., Vaschillo, E., & Vaschillo, B. (2000). Resonant frequency biofeedback training to increase cardiac variability: Rationale and manual for training. *Applied Psychophysiology and Biofeedback*, 25(3), 177–191. [DOI](https://doi.org/10.1023/A:1009554825745) | [PubMed](https://pubmed.ncbi.nlm.nih.gov/10999236/)
2. Vaschillo, E., Lehrer, P., Rishe, N., & Konstantinov, M. (2002). Heart rate variability biofeedback as a method for assessing baroreflex function: A preliminary study of resonance in the cardiovascular system. *Applied Psychophysiology and Biofeedback*, 27(1), 1–27. [DOI](https://doi.org/10.1023/A:1014587304314)
3. Lehrer, P., & Vaschillo, E. (2003/2004). Heart rate variability biofeedback: A new tool for improving autonomic homeostasis and treating emotional and psychosomatic diseases. *Japanese Journal of Biofeedback Research*, 30, 7–16. *(Open Access)* [DOI](https://doi.org/10.20595/jjbf.30.0_7) | [J-STAGE PDF](https://www.jstage.jst.go.jp/article/jjbf/30/0/30_KJ00003535185/_pdf/-char/en)
4. Vaschillo, E., Vaschillo, B., & Lehrer, P. (2004). Heartbeat synchronizes with respiratory rhythm only under specific circumstances. *Chest*, 126(4), 1385–1386. [DOI](https://doi.org/10.1378/chest.126.4.1385-a) | [PubMed](https://pubmed.ncbi.nlm.nih.gov/15486413/)
5. Vaschillo, E. G., Vaschillo, B., & Lehrer, P. M. (2006). Characteristics of resonance in heart rate variability stimulated by biofeedback. *Applied Psychophysiology and Biofeedback*, 31(2), 129–142. [DOI](https://doi.org/10.1007/s10484-006-9009-3) | [PubMed](https://pubmed.ncbi.nlm.nih.gov/16838124/)
6. Lehrer, P. M., & Gevirtz, R. (2014). Heart rate variability biofeedback: how and why does it work? *Frontiers in Psychology*, 5, 756. *(Open Access)* [Frontiers](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2014.00756/full) | [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC4104929/)
7. Steffen, P. R., Austin, T., DeBarros, A., & Brown, T. (2017). The impact of resonance frequency breathing on measures of heart rate variability, blood pressure, and mood. *Frontiers in Public Health*, 5, 222. *(Open Access)* [Frontiers](https://www.frontiersin.org/journals/public-health/articles/10.3389/fpubh.2017.00222/full) | [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC5575449/)
8. Shaffer, F., & Meehan, Z. M. (2020). A practical guide to resonance frequency assessment for heart rate variability biofeedback. *Frontiers in Neuroscience*, 14, 570400 (and Corrigendum, 14, 627512). *(Open Access)* [Frontiers](https://www.frontiersin.org/journals/neuroscience/articles/10.3389/fnins.2020.570400/full) | [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC7578229/)
9. Hasuo, H., Mori, K., Matsuoka, H., Sakuma, H., & Ishikawa, H. (2023/2024). An estimation formula for resonance frequency using sex and height for healthy individuals and patients with incurable cancers. *Applied Psychophysiology and Biofeedback*, 49(1), 125–132. *(Open Access)* [DOI](https://doi.org/10.1007/s10484-023-09602-5) | [PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC10869367/) | [PubMed](https://pubmed.ncbi.nlm.nih.gov/37702816/)
10. Task Force of the European Society of Cardiology and the North American Society of Pacing and Electrophysiology (1996). Heart rate variability: Standards of measurement, physiological interpretation, and clinical use. *Circulation*, 93(5), 1043–1065 / *European Heart Journal*, 17(3), 354–381. [Circulation DOI](https://doi.org/10.1161/01.CIR.93.5.1043) ([PubMed](https://pubmed.ncbi.nlm.nih.gov/8598068/)) | [EHJ DOI](https://doi.org/10.1093/oxfordjournals.eurheartj.a014868) ([PubMed](https://pubmed.ncbi.nlm.nih.gov/8737210/))
11. Tarvainen, M. P., Niskanen, J.-P., Lipponen, J. A., Ranta-aho, P. O., & Karjalainen, P. A. (2014). Kubios HRV – Heart rate variability analysis software. *Computer Methods and Programs in Biomedicine*, 113(1), 210–220. [DOI](https://doi.org/10.1016/j.cmpb.2013.07.024) | [PubMed](https://pubmed.ncbi.nlm.nih.gov/24054542/)

---

## Links

- **Garmin Connect IQ Store:** [Peak Frequency](https://apps.garmin.com/apps/174cda32-a42a-43b4-8b07-658ddda48d92?tid=0)
- **Web Version & Instructions:** https://mesw.github.io/PeakFrequency/
- **Privacy Policy:** [docs/privacy_policy.html](docs/privacy_policy.html)
- **Store Description:** [docs/app_description.md](docs/app_description.md)

---

## Disclaimer

This app is for general informational, wellness, and breathwork practice purposes only. It is **not** a medical device and is not intended to diagnose, treat, cure, or prevent any disease or medical condition. Consult a physician before starting a new breathing or exercise routine if you have any health concerns.
