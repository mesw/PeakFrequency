/**
 * Garmin Breath Pacer Component
 * Peak Frequency — HRV Resonance Breath Pacer for Garmin
 *
 * Implements:
 * 1. Organic Noise-Filtered Shepard Glissando Acoustics with Volume & Background Lookahead Scheduling
 * 2. 5-Tier Garmin Round Display Simulator with Zero-Layout-Shift State Diffing
 * 3. Hasuo et al. (2023) Biometric Resonance Estimation Model & Monotonic Wall-Clock Engine
 * 4. Full 2-Round Calibration Protocol (Round 1 ±0.25 BPM, Round 2 ±0.125 BPM) + Daily Practice Halfway Break
 * 5. Dual Export Pattern (window.GarminPacer / module.exports)
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var exports = factory();
    root.GarminPacer = exports.GarminPacer;
    root.BreathAudioSynth = exports.BreathAudioSynth;
    root.GarminWatchSimulator = exports.GarminWatchSimulator;
    root.PacerEngine = exports.PacerEngine;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clampBpm(val) {
    return Math.round(Math.max(3.5, Math.min(8.5, val)) * 1000) / 1000;
  }

  function clampInhaleRatioPct(val) {
    var n = Math.round(Number(val));
    if (isNaN(n)) return 40;
    return Math.max(25, Math.min(50, n));
  }

  function clampInhaleRatio(val) {
    var n = Number(val);
    if (isNaN(n)) return 0.40;
    return Math.max(0.25, Math.min(0.50, n));
  }

  function formatLocalizedNumber(val, decimals, lang) {
    var str = Number(val).toFixed(decimals);
    return lang === 'de' ? str.replace('.', ',') : str;
  }

  // =========================================================================
  // 1. ORGANIC NOISE-FILTERED SHEPARD GLISSANDO AUDIO SYNTHESIZER
  // =========================================================================
  class BreathAudioSynth {
    constructor() {
      this.ctx = null;
      this.masterGain = null;
      this.noiseSource = null;
      this.noiseBuffer = null;
      this.formantFilter = null;
      this.formantGain = null;
      this.shepardNoiseMasterGain = null;
      this.shepardFilterNodes = []; // { filter, gain }

      this.SHEPARD_BANDS = 7;
      this.SHEPARD_BASE_FREQ = 80;    // 80 Hz up to ~5.1 kHz
      this.SHEPARD_CENTER_FREQ = 640; // Vocal breath warmth center
      this.SHEPARD_SIGMA = 1.5;
      this.cuesEnabled = true;
      this.volume = 0.75; // 0..1 user-controllable softness
      this.inhaleRatio = 0.40; // 0.25..0.50 (25:75 to 50:50)
      this._lastClickCtxTime = -10;
      this._lastClickIsTop = null;
    }

    setInhaleRatio(ratio) {
      this.inhaleRatio = clampInhaleRatio(ratio);
      return this.inhaleRatio;
    }

    init() {
      if (!this.ctx) {
        try {
          var AudioCtx = window.AudioContext || window.webkitAudioContext;
          if (AudioCtx) this.ctx = new AudioCtx();
        } catch (e) {}
      }
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(function () {});
      }
    }

    setVolume(vol) {
      var clamped = Math.max(0, Math.min(1, Number(vol)));
      if (isNaN(clamped)) clamped = 0.75;
      this.volume = clamped;
      if (this.masterGain && this.ctx) {
        var now = this.ctx.currentTime;
        this.masterGain.gain.cancelScheduledValues(now);
        this.masterGain.gain.setTargetAtTime(Math.max(0.0001, this.volume), now, 0.03);
      }
      return this.volume;
    }

    createPinkNoiseBuffer(seconds) {
      if (!this.ctx) return null;
      var sec = seconds || 6;
      var bufferSize = this.ctx.sampleRate * sec;
      var buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
      var data = buffer.getChannelData(0);
      var b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (var i = 0; i < bufferSize; i++) {
        var white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
      }
      return buffer;
    }

    calculateShepardGain(freq) {
      if (freq <= 0) return 0;
      var dist = Math.log2(freq / this.SHEPARD_CENTER_FREQ);
      return Math.max(0, Math.exp(-0.5 * Math.pow(dist / this.SHEPARD_SIGMA, 2)));
    }

    start() {
      if (!this.cuesEnabled) return;
      this.init();
      if (!this.ctx) return;

      if (!this.masterGain) {
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.setValueAtTime(0.001, this.ctx.currentTime);
        this.masterGain.gain.linearRampToValueAtTime(Math.max(0.0001, this.volume), this.ctx.currentTime + 0.12);
        this.masterGain.connect(this.ctx.destination);
      }

      if (!this.noiseSource) {
        if (!this.noiseBuffer) {
          this.noiseBuffer = this.createPinkNoiseBuffer(6);
        }
        this.noiseSource = this.ctx.createBufferSource();
        this.noiseSource.buffer = this.noiseBuffer;
        this.noiseSource.loop = true;

        // 1. Natural Breath Formant Noise Path (Airy base layer)
        this.formantFilter = this.ctx.createBiquadFilter();
        this.formantFilter.type = 'bandpass';
        this.formantFilter.Q.value = 1.6;

        this.formantGain = this.ctx.createGain();
        this.formantGain.gain.value = 0;

        this.noiseSource.connect(this.formantFilter);
        this.formantFilter.connect(this.formantGain);
        this.formantGain.connect(this.masterGain);

        // 2. Shepard Resonant Filter Bank on Noise
        this.shepardNoiseMasterGain = this.ctx.createGain();
        this.shepardNoiseMasterGain.gain.value = 0;
        this.shepardNoiseMasterGain.connect(this.masterGain);

        this.shepardFilterNodes = [];
        for (var i = 0; i < this.SHEPARD_BANDS; i++) {
          var bpf = this.ctx.createBiquadFilter();
          bpf.type = 'bandpass';
          bpf.Q.value = 3.2;

          var bg = this.ctx.createGain();
          bg.gain.value = 0;

          this.noiseSource.connect(bpf);
          bpf.connect(bg);
          bg.connect(this.shepardNoiseMasterGain);

          this.shepardFilterNodes.push({ filter: bpf, gain: bg });
        }

        this.noiseSource.start();
      }
    }

    computeEnvelopeAt(cycleProgress, inhaleRatio) {
      var split = (typeof inhaleRatio === 'number') ? clampInhaleRatio(inhaleRatio) : this.inhaleRatio;
      var p = ((cycleProgress % 1.0) + 1.0) % 1.0;
      var isInhale = p < split;
      var phaseProgress = isInhale ? (p / split) : ((p - split) / (1.0 - split));
      var phaseFactor = isInhale
        ? (0.5 - 0.5 * Math.cos(phaseProgress * Math.PI))
        : (0.5 + 0.5 * Math.cos(phaseProgress * Math.PI));
      var pulseSine = Math.sin(phaseProgress * 4 * Math.PI);
      var pulseModulation = 0.78 + 0.22 * Math.abs(pulseSine);
      return {
        isInhale: isInhale,
        phaseFactor: phaseFactor,
        pulseModulation: pulseModulation
      };
    }

    clearAutomation(fromTime) {
      if (!this.ctx) return;
      if (this.formantFilter) {
        this.formantFilter.frequency.cancelScheduledValues(fromTime);
        this.formantFilter.Q.cancelScheduledValues(fromTime);
      }
      if (this.formantGain) {
        this.formantGain.gain.cancelScheduledValues(fromTime);
      }
      if (this.shepardNoiseMasterGain) {
        this.shepardNoiseMasterGain.gain.cancelScheduledValues(fromTime);
      }
      for (var i = 0; i < this.shepardFilterNodes.length; i++) {
        this.shepardFilterNodes[i].filter.frequency.cancelScheduledValues(fromTime);
        this.shepardFilterNodes[i].gain.gain.cancelScheduledValues(fromTime);
      }
    }

    updateFrame(isInhale, phaseFactor, pulseModulation) {
      if (!this.cuesEnabled || !this.ctx || this.ctx.state !== 'running') return;
      var now = this.ctx.currentTime;
      var timeConstant = 0.02;
      this.clearAutomation(now);

      if (this.formantGain && this.formantFilter) {
        var formantFreq, baseNoiseVol, qVal;
        if (isInhale) {
          formantFreq = 750 + (1600 - 750) * phaseFactor;
          baseNoiseVol = (0.05 + 0.28 * phaseFactor) * pulseModulation;
          qVal = 1.8;
        } else {
          formantFreq = 260 + (600 - 260) * phaseFactor;
          baseNoiseVol = (0.04 + 0.24 * phaseFactor) * pulseModulation;
          qVal = 1.2;
        }
        this.formantFilter.Q.setTargetAtTime(qVal, now, timeConstant);
        this.formantFilter.frequency.setTargetAtTime(formantFreq, now, timeConstant);
        this.formantGain.gain.setTargetAtTime(baseNoiseVol, now, timeConstant);
      }

      if (this.shepardNoiseMasterGain && this.shepardFilterNodes.length > 0) {
        var masterShepardVol = (0.08 + 0.34 * phaseFactor) * pulseModulation;
        this.shepardNoiseMasterGain.gain.setTargetAtTime(masterShepardVol, now, timeConstant);

        for (var i = 0; i < this.shepardFilterNodes.length; i++) {
          var freq = this.SHEPARD_BASE_FREQ * Math.pow(2, i + phaseFactor);
          var gain = this.calculateShepardGain(freq);
          this.shepardFilterNodes[i].filter.frequency.setTargetAtTime(freq, now, timeConstant);
          this.shepardFilterNodes[i].gain.gain.setTargetAtTime(gain, now, timeConstant);
        }
      }
    }

    /**
     * Schedules continuous breath modulation & upcoming turnaround clicks ahead on the Web Audio thread
     * so background/minimized browser tabs remain uninterrupted between ~1 Hz timer ticks.
     */
    scheduleLookahead(currentCycleProgress, bpm, horizonSec, inhaleRatio) {
      if (!this.cuesEnabled || !this.ctx || this.ctx.state !== 'running') return;
      var split = (typeof inhaleRatio === 'number') ? clampInhaleRatio(inhaleRatio) : this.inhaleRatio;
      var now = this.ctx.currentTime;
      var span = horizonSec || 1.35;
      var cycleDurationSec = 60.0 / Math.max(3.5, Math.min(8.5, bpm));
      var stepSec = 0.12;
      var steps = Math.max(2, Math.ceil(span / stepSec));

      this.clearAutomation(now);

      for (var k = 0; k <= steps; k++) {
        var dt = k * stepSec;
        var t = now + dt;
        var futureProgress = (currentCycleProgress + dt / cycleDurationSec) % 1.0;
        var env = this.computeEnvelopeAt(futureProgress, split);

        var formantFreq = env.isInhale
          ? (750 + (1600 - 750) * env.phaseFactor)
          : (260 + (600 - 260) * env.phaseFactor);
        var baseNoiseVol = (env.isInhale
          ? (0.05 + 0.28 * env.phaseFactor)
          : (0.04 + 0.24 * env.phaseFactor)) * env.pulseModulation;
        var qVal = env.isInhale ? 1.8 : 1.2;

        if (k === 0) {
          if (this.formantFilter && this.formantGain) {
            this.formantFilter.Q.setValueAtTime(qVal, t);
            this.formantFilter.frequency.setValueAtTime(formantFreq, t);
            this.formantGain.gain.setValueAtTime(baseNoiseVol, t);
          }
          if (this.shepardNoiseMasterGain) {
            this.shepardNoiseMasterGain.gain.setValueAtTime((0.08 + 0.34 * env.phaseFactor) * env.pulseModulation, t);
          }
          for (var i0 = 0; i0 < this.shepardFilterNodes.length; i0++) {
            var f0 = this.SHEPARD_BASE_FREQ * Math.pow(2, i0 + env.phaseFactor);
            this.shepardFilterNodes[i0].filter.frequency.setValueAtTime(f0, t);
            this.shepardFilterNodes[i0].gain.gain.setValueAtTime(this.calculateShepardGain(f0), t);
          }
        } else {
          if (this.formantFilter && this.formantGain) {
            this.formantFilter.Q.linearRampToValueAtTime(qVal, t);
            this.formantFilter.frequency.linearRampToValueAtTime(formantFreq, t);
            this.formantGain.gain.linearRampToValueAtTime(baseNoiseVol, t);
          }
          if (this.shepardNoiseMasterGain) {
            this.shepardNoiseMasterGain.gain.linearRampToValueAtTime((0.08 + 0.34 * env.phaseFactor) * env.pulseModulation, t);
          }
          for (var i = 0; i < this.shepardFilterNodes.length; i++) {
            var freq = this.SHEPARD_BASE_FREQ * Math.pow(2, i + env.phaseFactor);
            this.shepardFilterNodes[i].filter.frequency.linearRampToValueAtTime(freq, t);
            this.shepardFilterNodes[i].gain.gain.linearRampToValueAtTime(this.calculateShepardGain(freq), t);
          }
        }
      }

      // Schedule upcoming exhale turnaround (split) and inhale turnaround (1.00) inside span
      var dtPeak = (split - currentCycleProgress) * cycleDurationSec;
      if (dtPeak > 0.01 && dtPeak <= span) {
        this.playClick(true, now + dtPeak);
      }
      var dtBottom = (1.0 - currentCycleProgress) * cycleDurationSec;
      if (dtBottom > 0.01 && dtBottom <= span) {
        this.playClick(false, now + dtBottom);
      }
    }

    playClick(isTop, atCtxTime) {
      if (!this.cuesEnabled) return;
      this.init();
      if (!this.ctx) return;
      try {
        var targetTime = (typeof atCtxTime === 'number' && atCtxTime > this.ctx.currentTime)
          ? atCtxTime
          : this.ctx.currentTime;

        // Deduplicate foreground + background lookahead scheduling within 220ms
        if (Math.abs(targetTime - this._lastClickCtxTime) < 0.22 && this._lastClickIsTop === isTop) {
          return;
        }
        this._lastClickCtxTime = targetTime;
        this._lastClickIsTop = isTop;

        var osc = this.ctx.createOscillator();
        var gain = this.ctx.createGain();
        var startFreq = isTop ? 1800 : 1100;
        var endFreq = isTop ? 350 : 200;
        var peakGain = Math.max(0.0001, 0.24 * this.volume);

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(startFreq, targetTime);
        osc.frequency.exponentialRampToValueAtTime(endFreq, targetTime + 0.018);

        gain.gain.setValueAtTime(peakGain, targetTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, targetTime + 0.022);

        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(targetTime);
        osc.stop(targetTime + 0.025);
      } catch (e) {}
    }

    playBeep(freq, duration, type) {
      if (!this.cuesEnabled) return;
      this.init();
      if (!this.ctx) return;
      try {
        var f = freq || 440;
        var dur = duration || 0.15;
        var t = type || 'sine';
        var osc = this.ctx.createOscillator();
        var gain = this.ctx.createGain();
        var peakGain = Math.max(0.0001, 0.08 * this.volume);
        osc.type = t;
        osc.frequency.setValueAtTime(f, this.ctx.currentTime);
        gain.gain.setValueAtTime(peakGain, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + dur);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start();
        osc.stop(this.ctx.currentTime + dur);
      } catch (e) {}
    }

    stop(immediate) {
      if (!this.masterGain || !this.ctx) return;
      var now = this.ctx.currentTime;
      this.clearAutomation(now);
      this.masterGain.gain.cancelScheduledValues(now);
      var self = this;

      if (immediate) {
        this.masterGain.gain.setValueAtTime(0.001, now);
        this.cleanup();
      } else {
        this.masterGain.gain.linearRampToValueAtTime(0.001, now + 0.08);
        setTimeout(function () {
          self.cleanup();
        }, 100);
      }
    }

    cleanup() {
      try {
        if (this.noiseSource) {
          this.noiseSource.stop();
          this.noiseSource.disconnect();
          this.noiseSource = null;
        }
        for (var i = 0; i < this.shepardFilterNodes.length; i++) {
          try {
            this.shepardFilterNodes[i].filter.disconnect();
            this.shepardFilterNodes[i].gain.disconnect();
          } catch (e) {}
        }
        this.shepardFilterNodes = [];
        if (this.formantFilter) {
          this.formantFilter.disconnect();
          this.formantFilter = null;
        }
        if (this.formantGain) {
          this.formantGain.disconnect();
          this.formantGain = null;
        }
        if (this.shepardNoiseMasterGain) {
          this.shepardNoiseMasterGain.disconnect();
          this.shepardNoiseMasterGain = null;
        }
        if (this.masterGain) {
          this.masterGain.disconnect();
          this.masterGain = null;
        }
      } catch (e) {}
    }
  }

  // =========================================================================
  // 2. GARMIN SMARTWATCH 5-TIER DISPLAY SIMULATOR WITH STATE DIFFING
  // =========================================================================
  class GarminWatchSimulator {
    constructor(container) {
      this.container = typeof container === 'string' ? document.querySelector(container) : container;
      if (!this.container) return;

      this.directive = this.container.querySelector('#watchDirective');
      this.hint = this.container.querySelector('#watchHint');
      this.barTrack = this.container.querySelector('#watchBarTrack');
      this.barFill = this.container.querySelector('#watchBarFill');
      this.cadence = this.container.querySelector('#watchCadence');
      this.telemetry = this.container.querySelector('#watchTelemetry');

      this._lastState = {
        directive: null,
        directiveClass: null,
        hint: null,
        hintColor: null,
        showBar: null,
        fillPct: null,
        fillClass: null,
        cadenceText: null,
        cadenceColor: null,
        telemetryText: null
      };
    }

    render(state) {
      if (!this.container) return;

      if (this.directive && (state.directive !== this._lastState.directive || state.directiveClass !== this._lastState.directiveClass)) {
        this.directive.textContent = state.directive;
        this.directive.className = state.directiveClass || 'watch-directive';
        this._lastState.directive = state.directive;
        this._lastState.directiveClass = state.directiveClass;
      }

      if (this.hint && (state.hint !== this._lastState.hint || state.hintColor !== this._lastState.hintColor)) {
        this.hint.textContent = state.hint;
        this.hint.style.color = state.hintColor || '#ffffff';
        this._lastState.hint = state.hint;
        this._lastState.hintColor = state.hintColor;
      }

      if (this.barTrack && state.showBar !== this._lastState.showBar) {
        this.barTrack.style.display = state.showBar ? 'block' : 'none';
        this._lastState.showBar = state.showBar;
      }
      if (this.barFill && state.showBar && (state.fillPct !== this._lastState.fillPct || state.fillClass !== this._lastState.fillClass)) {
        this.barFill.style.width = state.fillPct + '%';
        this.barFill.className = state.fillClass || 'watch-bar-fill';
        this._lastState.fillPct = state.fillPct;
        this._lastState.fillClass = state.fillClass;
      } else if (this.barFill && !state.showBar && this._lastState.fillPct !== '0') {
        this.barFill.style.width = '0%';
        this._lastState.fillPct = '0';
      }

      if (this.cadence && (state.cadenceText !== this._lastState.cadenceText || state.cadenceColor !== this._lastState.cadenceColor)) {
        this.cadence.textContent = state.cadenceText;
        this.cadence.style.color = state.cadenceColor || '#00ffff';
        this._lastState.cadenceText = state.cadenceText;
        this._lastState.cadenceColor = state.cadenceColor;
      }

      if (this.telemetry && state.telemetryText !== this._lastState.telemetryText) {
        this.telemetry.textContent = state.telemetryText;
        this._lastState.telemetryText = state.telemetryText;
      }
    }
  }

  // =========================================================================
  // 3. PACER ENGINE & BIOMETRIC MATHEMATICS
  // =========================================================================
  class PacerEngine {
    constructor(options) {
      var opts = options || {};
      this.targetBpm = opts.targetBpm || 5.65;
      this.testCenterBpm = opts.targetBpm || 5.65;
      this.inhaleRatioPct = clampInhaleRatioPct(opts.inhaleRatioPct !== undefined ? opts.inhaleRatioPct : 40);
      this.inhaleRatio = this.inhaleRatioPct / 100.0;
      this.sessionMode = opts.sessionMode || 'TRAIN'; // 'TEST' | 'TRAIN'
      this.roundNumber = 1;
      this.legIndex = 0; // 0 = center, 1 = higher (+step), 2 = lower (-step)
      this.totalElapsedSec = 0;
      this.trainingDurationMin = opts.trainingDurationMin || 10;
      this.trainingRemainingSec = this.trainingDurationMin * 60;
      this.halfwayBreakSec = opts.halfwayBreakSec || 0;
      this.halfwayBreakTaken = false;
      this.testRestSec = opts.testRestSec || 120;
      this.testPaceSec = opts.testPaceSec || 120;
      this.phase = this.sessionMode === 'TEST' ? 'REST' : 'PACE'; // 'REST' | 'PACE' | 'BREAK' | 'ROUND1_EVAL'
      this.phaseRemainingSec = this.sessionMode === 'TEST' ? this.testRestSec : this.trainingRemainingSec;
      this.breathPhase = 0.0;
      this.baselineRsaBpm = opts.baselineRsaBpm || 10.0;
      this.latestBreathDeltaHR = 0.0;
      this.latestBreathExcursion = 0.0;
      this.completedBreathsCount = 0;
      this.breathHistory = [];
      this.stageCycles = [];
      this.testResults = [];
      this.round1Winner = null;
      this.winningResult = null;
    }

    static calculateEstimatedBpm(heightCm, sex) {
      var est = (sex === 'female')
        ? (15.88 - (0.06 * heightCm))
        : (17.90 - (0.07 * heightCm));
      est = Math.max(4.5, Math.min(6.5, est));
      return (Math.round(est * 20) / 20).toFixed(2);
    }

    static calculateLungVolume(phaseNorm, inhaleRatio) {
      var split = clampInhaleRatio(inhaleRatio !== undefined ? inhaleRatio : 0.40);
      if (phaseNorm < split) {
        return 0.5 * (1.0 - Math.cos(Math.PI * (phaseNorm / split)));
      } else {
        return 0.5 * (1.0 + Math.cos(Math.PI * ((phaseNorm - split) / (1.0 - split))));
      }
    }

    static calculateFillFraction(cycleProgress, inhaleRatio) {
      var split = clampInhaleRatio(inhaleRatio !== undefined ? inhaleRatio : 0.40);
      var clamped = Math.max(0.0, Math.min(1.0, cycleProgress));
      if (clamped < split) {
        return clamped / split;
      } else {
        return 1.0 - ((clamped - split) / (1.0 - split));
      }
    }

    static formatMMSS(sec) {
      var safe = Math.max(0, Math.floor(sec));
      var m = Math.floor(safe / 60).toString().padStart(2, '0');
      var s = Math.floor(safe % 60).toString().padStart(2, '0');
      return m + ':' + s;
    }

    static scoreStageCycles(cycles, bpm, roundNumber, legKey, totalRestoredLegIdx) {
      var total = cycles ? cycles.length : 0;
      if (total === 0) {
        return {
          round: roundNumber,
          legKey: legKey,
          stageOrder: totalRestoredLegIdx,
          bpm: bpm,
          cyclesUsed: 0,
          meanDeltaHR: null,
          meanPhaseLagMs: null,
          resonanceScore: null
        };
      }
      // Discard first half (~60s settling) when at least 2 cycles were captured
      var cutoff = total >= 2 ? Math.floor(total / 2) : 0;
      var settled = cycles.slice(cutoff);
      var sumDelta = 0;
      var sumLag = 0;
      for (var i = 0; i < settled.length; i++) {
        sumDelta += settled[i].deltaHR || 0;
        sumLag += settled[i].phaseLagMs || 0;
      }
      var avgDelta = sumDelta / settled.length;
      var avgLag = Math.round(sumLag / settled.length);
      var absLag = Math.abs(avgLag);
      var phaseMult = 1.0;
      if (absLag > 1200) {
        phaseMult = Math.max(0.35, 1.0 - (absLag - 1200) / 3500.0);
      }
      var score = avgDelta >= 1.0 ? Math.round(avgDelta * phaseMult * 100) / 100 : 0;
      return {
        round: roundNumber,
        legKey: legKey,
        stageOrder: totalRestoredLegIdx,
        bpm: bpm,
        cyclesUsed: settled.length,
        meanDeltaHR: Math.round(avgDelta * 10) / 10,
        meanPhaseLagMs: avgLag,
        resonanceScore: score
      };
    }
  }

  // =========================================================================
  // 4. GARMIN PACER COMPONENT ORCHESTRATOR
  // =========================================================================
  class GarminPacer {
    constructor(containerSelector, options) {
      this.options = options || {};
      this.container = typeof containerSelector === 'string'
        ? document.querySelector(containerSelector)
        : containerSelector;

      this.audio = new BreathAudioSynth();
      this.engine = new PacerEngine({
        targetBpm: this.options.targetBpm || 5.65,
        inhaleRatioPct: this.options.inhaleRatioPct !== undefined ? this.options.inhaleRatioPct : 40,
        sessionMode: this.options.sessionMode || 'TRAIN',
        trainingDurationMin: this.options.trainingDurationMin || 10,
        halfwayBreakSec: this.options.halfwayBreakSec || 0,
        testRestSec: this.options.testRestSec || 120,
        testPaceSec: this.options.testPaceSec || 120
      });
      this.audio.setInhaleRatio(this.engine.inhaleRatio);

      this.isRunning = false;
      this.currentHR = 0;
      this.cuesEnabled = true;
      this.timerInterval = null;
      this.animFrameId = null;
      this.lastWallMs = null;
      this.secAccumulatorMs = 0;
      this.lastInhaleState = false;
      this.somaticHintIndex = 0;
      this.wakeLock = null;
      this._boundVisibilityHandler = null;

      this.INHALE_HINTS = ['Through nose', 'Easily into belly', 'Normal, shallow', 'Quiet, relaxed', 'Belly out', 'Chest still'];
      this.EXHALE_HINTS = ['Relax shoulders', 'Pursed lips', 'Stay shallow', 'Relax jaw', 'Gently', 'Without force'];
      this.currentLang = 'en';
      this.strings = (window.PEAK_I18N && window.PEAK_I18N.en && window.PEAK_I18N.en.strings) || {};

      this._initSimulator();
    }

    _initSimulator() {
      if (this.container) {
        var watchChassis = this.container.querySelector('.watch-chassis-wrap') || this.container;
        this.simulator = new GarminWatchSimulator(watchChassis);
      }
    }

    setLanguage(lang, customStrings) {
      this.currentLang = (lang === 'de') ? 'de' : 'en';
      if (customStrings) {
        this.strings = customStrings;
      } else if (window.PEAK_I18N && window.PEAK_I18N[this.currentLang]) {
        this.strings = window.PEAK_I18N[this.currentLang].strings || {};
      }

      this.INHALE_HINTS = [
        this.strings.hint_in_1 || 'Easily into belly',
        this.strings.hint_in_2 || 'Through nose',
        this.strings.hint_in_3 || 'Normal, shallow',
        this.strings.hint_in_4 || 'Quiet, relaxed',
        this.strings.hint_in_5 || 'Belly out',
        this.strings.hint_in_6 || 'Chest still'
      ];
      this.EXHALE_HINTS = [
        this.strings.hint_out_1 || 'Pursed lips',
        this.strings.hint_out_2 || 'Stay shallow',
        this.strings.hint_out_3 || 'Relax shoulders',
        this.strings.hint_out_4 || 'Relax jaw',
        this.strings.hint_out_5 || 'Gently',
        this.strings.hint_out_6 || 'Without force'
      ];

      this.renderWatch();
    }

    getActiveHRDisplay() {
      return this.currentHR > 0 ? this.currentHR : '--';
    }

    setHeartRate(hr) {
      this.currentHR = hr;
      this.renderWatch();
    }

    setTargetBpm(bpm) {
      var clamped = clampBpm(parseFloat(bpm) || 5.65);
      this.engine.targetBpm = clamped;
      if (this.engine.sessionMode === 'TEST' && this.engine.totalElapsedSec === 0) {
        this.engine.testCenterBpm = clamped;
      }
      this.renderWatch();
    }

    setInhaleRatioPct(pct) {
      var clampedPct = clampInhaleRatioPct(pct);
      this.engine.inhaleRatioPct = clampedPct;
      this.engine.inhaleRatio = clampedPct / 100.0;
      this.audio.setInhaleRatio(this.engine.inhaleRatio);
      this.renderWatch();
      return clampedPct;
    }

    setHalfwayBreak(sec) {
      this.engine.halfwayBreakSec = Math.max(0, parseInt(sec, 10) || 0);
    }

    setVolume(vol) {
      return this.audio.setVolume(vol);
    }

    recordBreathMetrics(metrics) {
      if (!metrics) return;
      if (this.engine.sessionMode === 'TEST' && this.engine.phase === 'PACE') {
        this.engine.stageCycles.push({
          deltaHR: metrics.deltaHR,
          phaseLagMs: metrics.phaseLagMs || 0
        });
      }
    }

    setSessionMode(mode) {
      this.engine.sessionMode = mode === 'TEST' ? 'TEST' : 'TRAIN';
      this.reset();
    }

    requestWakeLock() {
      var self = this;
      if (typeof navigator !== 'undefined' && 'wakeLock' in navigator && typeof document !== 'undefined' && document.visibilityState === 'visible') {
        navigator.wakeLock.request('screen').then(function (lock) {
          self.wakeLock = lock;
          lock.addEventListener('release', function () {
            self.wakeLock = null;
          });
        }).catch(function () {});
      }
    }

    releaseWakeLock() {
      if (this.wakeLock) {
        this.wakeLock.release().catch(function () {});
        this.wakeLock = null;
      }
    }

    triggerHaptic(pattern) {
      if (!this.cuesEnabled) return;
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        try { navigator.vibrate(pattern); } catch (e) {}
      }
    }

    toggleAudio(enabled) {
      this.cuesEnabled = (enabled !== undefined) ? enabled : !this.cuesEnabled;
      this.audio.cuesEnabled = this.cuesEnabled;
      if (this.cuesEnabled) {
        this.triggerHaptic(40);
        this.audio.playClick(false);
        if (this.isRunning && this.engine.phase === 'PACE') {
          this.audio.start();
        }
      } else {
        this.audio.stop(true);
      }
      return this.cuesEnabled;
    }

    getLegBpm(roundNum, legIdx, centerBpm) {
      var step = roundNum === 1 ? 0.25 : 0.125;
      if (legIdx === 0) return clampBpm(centerBpm);
      if (legIdx === 1) return clampBpm(centerBpm + step);
      return clampBpm(centerBpm - step);
    }

    getCurrentLegName() {
      var s = this.strings;
      var de = this.currentLang === 'de';
      if (this.engine.legIndex === 1) return s.leg_higher || (de ? 'Höher' : 'Higher');
      if (this.engine.legIndex === 2) return s.leg_lower || (de ? 'Tiefer' : 'Lower');
      return s.leg_center || (de ? 'Mitte' : 'Center');
    }

    _pickRoundWinner(results) {
      var best = null;
      for (var i = 0; i < results.length; i++) {
        var r = results[i];
        if (r && r.resonanceScore !== null) {
          if (!best || r.resonanceScore > best.resonanceScore) {
            best = r;
          }
        }
      }
      if (!best && results.length > 0) {
        best = results[0];
      }
      return best;
    }

    setPhase(phase, playCues) {
      this.engine.phase = phase;

      if (this.engine.sessionMode === 'TRAIN') {
        if (phase === 'BREAK') {
          this.engine.phaseRemainingSec = this.engine.halfwayBreakSec || 60;
          this.audio.stop(false);
          if (playCues) {
            this.audio.playBeep(330, 0.3);
            this.triggerHaptic([80, 50, 80]);
          }
        } else {
          this.engine.phase = 'PACE';
          this.engine.phaseRemainingSec = this.engine.trainingRemainingSec;
          this.engine.breathPhase = 0.0;
          this.lastInhaleState = false;
          if (playCues) {
            this.audio.playBeep(660, 0.35);
            this.triggerHaptic([100, 60, 100]);
          }
        }
      } else {
        if (phase === 'REST') {
          this.engine.phaseRemainingSec = this.engine.testRestSec;
          this.audio.stop(false);
          if (playCues) {
            this.audio.playBeep(330, 0.3);
            this.triggerHaptic([80, 50, 80]);
          }
        } else if (phase === 'ROUND1_EVAL') {
          this.engine.phaseRemainingSec = 0;
          this.audio.stop(false);
          if (playCues) {
            this.audio.playBeep(523.25, 0.4);
            this.triggerHaptic([100, 60, 100]);
          }
        } else {
          this.engine.phase = 'PACE';
          this.engine.phaseRemainingSec = this.engine.testPaceSec;
          this.engine.breathPhase = 0.0;
          this.engine.stageCycles = [];
          this.lastInhaleState = false;
          this.engine.targetBpm = this.getLegBpm(this.engine.roundNumber, this.engine.legIndex, this.engine.testCenterBpm);
          if (playCues) {
            this.audio.playBeep(660, 0.35);
            this.triggerHaptic([100, 60, 100]);
          }
        }
      }

      this.renderWatch();
      if (typeof this.options.onPhaseChange === 'function') {
        this.options.onPhaseChange({
          phase: this.engine.phase,
          roundNumber: this.engine.roundNumber,
          legIndex: this.engine.legIndex,
          targetBpm: this.engine.targetBpm
        });
      }
    }

    _recordFinishedLeg() {
      var legKeys = ['center', 'higher', 'lower'];
      var res = PacerEngine.scoreStageCycles(
        this.engine.stageCycles,
        this.engine.targetBpm,
        this.engine.roundNumber,
        legKeys[this.engine.legIndex] || 'center',
        this.engine.testResults.length + 1
      );
      this.engine.testResults.push(res);
      this.engine.stageCycles = [];
      return res;
    }

    advancePhase() {
      if (this.engine.sessionMode === 'TRAIN') {
        if (this.engine.phase === 'BREAK') {
          this.engine.halfwayBreakTaken = true;
          this.setPhase('PACE', true);
          return;
        }
        this.completeSession();
        return;
      }

      if (this.engine.phase === 'REST') {
        this.setPhase('PACE', true);
        return;
      }

      if (this.engine.phase === 'ROUND1_EVAL') {
        this.continueToRound2();
        return;
      }

      // Finished an active PACE leg in TEST mode
      this._recordFinishedLeg();

      if (this.engine.legIndex < 2) {
        this.engine.legIndex++;
        this.engine.targetBpm = this.getLegBpm(this.engine.roundNumber, this.engine.legIndex, this.engine.testCenterBpm);
        this.setPhase('REST', true);
        return;
      }

      // Finished leg 2 of current round
      if (this.engine.roundNumber === 1) {
        var r1Winner = this._pickRoundWinner(this.engine.testResults);
        this.engine.round1Winner = r1Winner;
        if (r1Winner && r1Winner.bpm) {
          this.engine.testCenterBpm = r1Winner.bpm;
          this.engine.targetBpm = r1Winner.bpm;
        }
        this.pause();
        this.setPhase('ROUND1_EVAL', true);
        if (typeof this.options.onRoundEval === 'function') {
          this.options.onRoundEval({
            round1Results: this.engine.testResults.slice(),
            winner: r1Winner
          });
        }
        return;
      }

      // Finished Round 2 -> select overall winner & complete calibration
      var r2Results = this.engine.testResults.filter(function (r) { return r.round === 2; });
      this.engine.winningResult = this._pickRoundWinner(r2Results.length ? r2Results : this.engine.testResults);
      if (this.engine.winningResult && this.engine.winningResult.bpm) {
        this.engine.targetBpm = this.engine.winningResult.bpm;
      }
      this.completeSession();
    }

    continueToRound2() {
      this.engine.roundNumber = 2;
      this.engine.legIndex = 0;
      this.setPhase('REST', false);
      this.start();
    }

    finishCalibrationEarly() {
      this.engine.winningResult = this.engine.round1Winner || this._pickRoundWinner(this.engine.testResults);
      if (this.engine.winningResult && this.engine.winningResult.bpm) {
        this.engine.targetBpm = this.engine.winningResult.bpm;
      }
      this.completeSession();
    }

    completeSession() {
      this.pause();
      this.triggerHaptic([150, 100, 150, 100, 250]);
      this.audio.playBeep(880, 0.55);
      if (typeof this.options.onSessionComplete === 'function') {
        this.options.onSessionComplete({
          sessionMode: this.engine.sessionMode,
          durationMin: this.engine.trainingDurationMin,
          completedBreaths: this.engine.completedBreathsCount,
          breathHistory: this.engine.breathHistory,
          testResults: this.engine.testResults ? this.engine.testResults.slice() : [],
          winningResult: this.engine.winningResult || this.engine.round1Winner || null
        });
      }
    }

    start() {
      if (this.isRunning) return;
      if (this.engine.phase === 'ROUND1_EVAL') {
        this.continueToRound2();
        return;
      }
      this.audio.init();
      this.requestWakeLock();
      this.isRunning = true;
      this.lastWallMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      this.secAccumulatorMs = 0;
      var self = this;

      if (!this._boundVisibilityHandler && typeof document !== 'undefined') {
        this._boundVisibilityHandler = function () {
          if (!self.isRunning) return;
          if (document.visibilityState === 'visible') {
            self.requestWakeLock();
            if (!self.animFrameId && typeof requestAnimationFrame === 'function') {
              self.animFrameId = requestAnimationFrame(function () {
                self.updateVisualLoop();
              });
            }
          }
        };
        document.addEventListener('visibilitychange', this._boundVisibilityHandler);
      }

      if (!this.timerInterval) {
        this.timerInterval = setInterval(function () {
          self._heartbeatStep();
        }, 250);
      }
      if (!this.animFrameId && typeof requestAnimationFrame === 'function') {
        this.animFrameId = requestAnimationFrame(function () {
          self.updateVisualLoop();
        });
      }
    }

    pause() {
      if (!this.isRunning) return;
      this.isRunning = false;
      this.lastWallMs = null;
      this.releaseWakeLock();
      this.audio.stop(false);

      if (this.timerInterval) {
        clearInterval(this.timerInterval);
        this.timerInterval = null;
      }
      if (this.animFrameId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(this.animFrameId);
        this.animFrameId = null;
      }

      this.renderWatch();
    }

    reset() {
      this.pause();
      this.audio.stop(true);
      this.engine.roundNumber = 1;
      this.engine.legIndex = 0;
      this.engine.totalElapsedSec = 0;
      this.engine.breathPhase = 0.0;
      this.engine.testCenterBpm = this.engine.targetBpm;
      this.lastWallMs = null;
      this.secAccumulatorMs = 0;
      this.lastInhaleState = false;
      this.engine.trainingRemainingSec = this.engine.trainingDurationMin * 60;
      this.engine.halfwayBreakTaken = false;
      this.engine.completedBreathsCount = 0;
      this.engine.breathHistory = [];
      this.engine.stageCycles = [];
      this.engine.testResults = [];
      this.engine.round1Winner = null;
      this.engine.winningResult = null;
      this.engine.latestBreathDeltaHR = 0.0;
      this.engine.latestBreathExcursion = 0.0;

      if (this.engine.sessionMode === 'TRAIN') {
        this.engine.phaseRemainingSec = this.engine.trainingRemainingSec;
        this.setPhase('PACE', false);
      } else {
        this.setPhase('REST', false);
      }
      this.renderWatch();
    }

    _stepWallClock(nowMs, isBackground) {
      if (!this.isRunning) return;
      var currentMs = (typeof nowMs === 'number')
        ? nowMs
        : ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now());
      if (this.lastWallMs === null) {
        this.lastWallMs = currentMs;
        return;
      }
      var dtMs = Math.max(0, Math.min(120000, currentMs - this.lastWallMs));
      this.lastWallMs = currentMs;

      // Advance breath phase monotonically even when backgrounded
      if (this.engine.phase === 'PACE') {
        this.audio.start();
        var cycleDurationMs = (60.0 / this.engine.targetBpm) * 1000;
        var prevBreathPhase = this.engine.breathPhase;
        var totalStep = this.engine.breathPhase + (dtMs / cycleDurationMs);
        var wraps = Math.floor(totalStep);
        this.engine.breathPhase = totalStep - wraps;

        if (wraps > 0 || this.engine.breathPhase < prevBreathPhase) {
          this.engine.completedBreathsCount += Math.max(1, wraps);
          if (typeof this.options.onBreathCycle === 'function') {
            this.options.onBreathCycle({
              breathIndex: this.engine.completedBreathsCount,
              currentHR: this.currentHR
            });
          }
        }

        var cycleProgress = this.engine.breathPhase;
        var split = this.engine.inhaleRatio || 0.40;
        var isInhale = cycleProgress < split;

        if (isInhale && !this.lastInhaleState) {
          this.audio.playClick(false);
          this.triggerHaptic(50);
          this.lastInhaleState = true;
        } else if (!isInhale && this.lastInhaleState) {
          this.audio.playClick(true);
          this.triggerHaptic([30, 40, 30]);
          this.lastInhaleState = false;
          this.somaticHintIndex++;
        }

        if (isBackground) {
          this.audio.scheduleLookahead(cycleProgress, this.engine.targetBpm, 1.4, split);
        } else {
          var env = this.audio.computeEnvelopeAt(cycleProgress, split);
          this.audio.updateFrame(env.isInhale, env.phaseFactor, env.pulseModulation);
        }
      }

      // Accumulate exact elapsed seconds without timer drift
      this.secAccumulatorMs += dtMs;
      while (this.secAccumulatorMs >= 1000 && this.isRunning) {
        this.secAccumulatorMs -= 1000;
        this.tick();
      }
    }

    _heartbeatStep() {
      if (!this.isRunning) return;
      var nowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      var hidden = (typeof document !== 'undefined' && document.hidden === true);
      if (hidden || typeof requestAnimationFrame !== 'function') {
        this._stepWallClock(nowMs, hidden);
        if (!hidden) this.renderWatch();
      } else {
        // Fallback guard in case rAF stalled without visibility hidden
        if (this.lastWallMs !== null && (nowMs - this.lastWallMs) > 350) {
          this._stepWallClock(nowMs, false);
          this.renderWatch();
        }
      }
    }

    tick() {
      this.engine.totalElapsedSec++;

      if (this.engine.sessionMode === 'TRAIN') {
        if (this.engine.phase === 'BREAK') {
          this.engine.phaseRemainingSec = Math.max(0, this.engine.phaseRemainingSec - 1);
          if (this.engine.phaseRemainingSec <= 0) {
            this.engine.halfwayBreakTaken = true;
            this.setPhase('PACE', true);
          }
        } else {
          this.engine.trainingRemainingSec = Math.max(0, this.engine.trainingRemainingSec - 1);
          this.engine.phaseRemainingSec = this.engine.trainingRemainingSec;

          var halfSec = Math.floor((this.engine.trainingDurationMin * 60) / 2);
          if (
            this.engine.halfwayBreakSec > 0 &&
            !this.engine.halfwayBreakTaken &&
            this.engine.trainingRemainingSec > 10 &&
            this.engine.trainingRemainingSec <= halfSec
          ) {
            this.setPhase('BREAK', true);
          } else if (this.engine.trainingRemainingSec <= 0) {
            this.completeSession();
            return;
          }
        }
      } else {
        this.engine.phaseRemainingSec--;
        if (this.engine.phaseRemainingSec <= 0) {
          this.advancePhase();
        }
      }

      if (typeof this.options.onTick === 'function') {
        this.options.onTick({
          totalElapsedSec: this.engine.totalElapsedSec,
          phaseRemainingSec: this.engine.phaseRemainingSec,
          phase: this.engine.phase,
          roundNumber: this.engine.roundNumber,
          legIndex: this.engine.legIndex,
          targetBpm: this.engine.targetBpm
        });
      }
    }

    renderWatch() {
      if (!this.simulator) return;
      var s = this.strings;
      var de = this.currentLang === 'de';
      var bpm = this.engine.targetBpm;
      var bpmStr = formatLocalizedNumber(bpm, 2, this.currentLang);
      var hrTxt = s.hr_label || (de ? 'HF' : 'HR');
      var unitTxt = s.bpm_unit || 'BPM';
      var minShort = de ? 'Min.' : 'm left';
      var resLabel = de ? 'Resonanz:' : 'Resonance:';
      var secLeftTxt = s.seconds_left || (de ? 's übrig' : 's left');
      var state = {};

      if (this.engine.phase === 'ROUND1_EVAL') {
        state.directive = (s.round1_complete || (de ? 'RUNDE 1 BEENDET' : 'ROUND 1 COMPLETE')).toUpperCase();
        state.directiveClass = 'watch-directive rest';
        state.hint = s.start_round_2 ? s.start_round_2.replace(/[[\]]/g, '') : (de ? 'Runde 2 starten?' : 'Ready for Round 2');
        state.hintColor = '#2dd4bf';
        state.showBar = false;
        state.fillPct = '0';
        state.cadenceText = (s.winning_rf || (de ? 'R1 Favorit:' : 'R1 Winner:')) + ' ' + bpmStr + ' ' + unitTxt;
        state.cadenceColor = '#00ffff';
        state.telemetryText = hrTxt + ': ' + this.getActiveHRDisplay() + ' | ' + (de ? 'Runde 1' : 'Round 1');
      } else if (!this.isRunning && this.engine.totalElapsedSec === 0) {
        state.directive = s.AppName || 'PEAK FREQUENCY';
        state.directiveClass = 'watch-directive';
        state.hint = de ? 'Unten auf Start klicken' : 'Tap Start Below';
        state.hintColor = '#e2e8f0';
        state.showBar = this.engine.sessionMode === 'TRAIN';
        state.fillPct = '0';
        if (this.engine.sessionMode === 'TRAIN') {
          state.cadenceText = resLabel + ' ' + bpmStr + ' ' + unitTxt;
          state.cadenceColor = '#00ffff';
          state.telemetryText = hrTxt + ': ' + this.getActiveHRDisplay() + ' | ' + this.engine.trainingDurationMin + ' ' + minShort;
        } else {
          var rTxt = s.round_prefix || 'R';
          var legTxt = this.getCurrentLegName();
          state.cadenceText = rTxt + '1 ' + legTxt + ': ' + bpmStr + ' ' + unitTxt;
          state.cadenceColor = '#00ffff';
          state.telemetryText = hrTxt + ': ' + this.getActiveHRDisplay() + ' | ' + this.engine.testRestSec + ' ' + secLeftTxt;
        }
      } else if (!this.isRunning && this.engine.totalElapsedSec > 0) {
        state.directive = (s.session_paused || (de ? 'PAUSE' : 'PAUSED')).toUpperCase();
        state.directiveClass = 'watch-directive rest';
        state.hint = s.start_continue ? s.start_continue.replace(/[[\]]/g, '') : (de ? 'Pausiert' : 'Session paused');
        state.hintColor = '#fbbf24';
        state.showBar = false;
        state.fillPct = '0';
        state.cadenceText = resLabel + ' ' + bpmStr + ' ' + unitTxt;
        state.cadenceColor = '#00ffff';
        state.telemetryText = hrTxt + ': ' + this.getActiveHRDisplay() + ' | ' + Math.max(0, this.engine.phaseRemainingSec) + ' ' + secLeftTxt;
      } else if (this.engine.phase === 'BREAK' && this.engine.sessionMode === 'TRAIN') {
        state.directive = (de ? 'HALBZEIT-PAUSE' : 'HALFWAY BREAK');
        state.directiveClass = 'watch-directive rest';
        state.hint = s.breathe_naturally || (de ? 'Natürlich atmen' : 'Breathe naturally');
        state.hintColor = '#94a3b8';
        state.showBar = false;
        state.fillPct = '0';
        state.cadenceText = s.free_natural_breathing || (de ? 'Freies Atmen' : 'Free Natural Breathing');
        state.cadenceColor = '#22c55e';
        state.telemetryText = hrTxt + ': ' + this.getActiveHRDisplay() + ' | ' + Math.max(0, this.engine.phaseRemainingSec) + ' ' + secLeftTxt;
      } else if (this.engine.phase === 'REST' && this.engine.sessionMode === 'TEST') {
        state.directive = (s.rest_baseline_title || (de ? 'RUHE-BASISLINIE' : 'REST BASELINE')).toUpperCase();
        state.directiveClass = 'watch-directive rest';
        state.hint = s.breathe_naturally || (de ? 'Natürlich atmen' : 'Breathe naturally');
        state.hintColor = '#94a3b8';
        state.showBar = false;
        state.fillPct = '0';
        var nextTxt = s.next_prefix || (de ? 'Weiter' : 'Next');
        var rPrefix = s.round_prefix || 'R';
        var nextLegTxt = this.getCurrentLegName();
        state.cadenceText = nextTxt + ': ' + rPrefix + this.engine.roundNumber + ' ' + nextLegTxt + ' ' + bpmStr;
        state.cadenceColor = '#22c55e';
        state.telemetryText = hrTxt + ': ' + this.getActiveHRDisplay() + ' | ' + Math.max(0, this.engine.phaseRemainingSec) + ' ' + secLeftTxt;
      } else {
        var cycleProgress = this.engine.breathPhase;
        var split = this.engine.inhaleRatio || 0.40;
        var isInhale = cycleProgress < split;
        var fillFraction = PacerEngine.calculateFillFraction(cycleProgress, split);
        state.directive = isInhale ? (s.pacer_inhale || 'BREATHE IN') : (s.pacer_exhale || 'BREATHE OUT');
        state.directiveClass = isInhale ? 'watch-directive' : 'watch-directive exhale';
        state.hint = isInhale
          ? this.INHALE_HINTS[this.somaticHintIndex % this.INHALE_HINTS.length]
          : this.EXHALE_HINTS[this.somaticHintIndex % this.EXHALE_HINTS.length];
        state.hintColor = '#ffffff';
        state.showBar = true;
        state.fillPct = (fillFraction * 100).toFixed(1);
        state.fillClass = isInhale ? 'watch-bar-fill' : 'watch-bar-fill exhale';

        if (this.engine.sessionMode === 'TRAIN') {
          state.cadenceText = resLabel + ' ' + bpmStr + ' ' + unitTxt;
          state.cadenceColor = '#00ffff';
          var mLeft = Math.ceil(this.engine.phaseRemainingSec / 60);
          state.telemetryText = hrTxt + ': ' + this.getActiveHRDisplay() + ' | ' + mLeft + ' ' + minShort;
        } else {
          var rp = s.round_prefix || 'R';
          var lg = this.getCurrentLegName();
          state.cadenceText = rp + this.engine.roundNumber + ' ' + lg + ': ' + bpmStr + ' ' + unitTxt;
          state.cadenceColor = '#00ffff';
          state.telemetryText = hrTxt + ': ' + this.getActiveHRDisplay() + ' | ' + Math.max(0, this.engine.phaseRemainingSec) + ' ' + secLeftTxt;
        }
      }
      this.simulator.render(state);
    }

    updateVisualLoop() {
      if (!this.isRunning) {
        this.animFrameId = null;
        return;
      }

      var nowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      this._stepWallClock(nowMs, false);
      this.renderWatch();

      var self = this;
      if (typeof requestAnimationFrame === 'function' && (typeof document === 'undefined' || document.visibilityState === 'visible')) {
        this.animFrameId = requestAnimationFrame(function () {
          self.updateVisualLoop();
        });
      } else {
        this.animFrameId = null;
      }
    }
  }

  return {
    GarminPacer: GarminPacer,
    BreathAudioSynth: BreathAudioSynth,
    GarminWatchSimulator: GarminWatchSimulator,
    PacerEngine: PacerEngine
  };
});
