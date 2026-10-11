/**
 * Garmin Breath Pacer Component
 * Peak Frequency — HRV Resonance Breath Pacer for Garmin
 *
 * Implements:
 * 1. Organic Noise-Filtered Shepard Glissando Acoustics (GEMINI.md Section 7.C)
 * 2. 5-Tier Garmin Round Display Simulator with Zero-Layout-Shift State Diffing (GEMINI.md Section 7.D)
 * 3. Hasuo et al. (2023) Biometric Resonance Estimation Model
 * 4. Dual Export Pattern (window.GarminPacer / module.exports)
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
        this.masterGain.gain.linearRampToValueAtTime(1.0, this.ctx.currentTime + 0.1);
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

    updateFrame(isInhale, phaseFactor, pulseModulation) {
      if (!this.cuesEnabled || !this.ctx || this.ctx.state !== 'running') return;
      var now = this.ctx.currentTime;
      var timeConstant = 0.02; // Anti-zipper smoothing

      // 1. Vocal Breath Formants (Inhale: 750->1600 Hz, Exhale: 600->260 Hz)
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

      // 2. Shepard Resonant Filter Bank over Noise (Zero Sine Siren)
      if (this.shepardNoiseMasterGain && this.shepardFilterNodes.length > 0) {
        var masterShepardVol = (0.08 + 0.34 * phaseFactor) * pulseModulation;
        this.shepardNoiseMasterGain.gain.setTargetAtTime(masterShepardVol, now, timeConstant);

        for (var i = 0; i < this.SHEPARD_BANDS; i++) {
          var freq = this.SHEPARD_BASE_FREQ * Math.pow(2, i + phaseFactor);
          var gain = this.calculateShepardGain(freq);
          this.shepardFilterNodes[i].filter.frequency.setTargetAtTime(freq, now, timeConstant);
          this.shepardFilterNodes[i].gain.gain.setTargetAtTime(gain, now, timeConstant);
        }
      }
    }

    playClick(isTop) {
      if (!this.cuesEnabled) return;
      this.init();
      if (!this.ctx) return;
      try {
        var now = this.ctx.currentTime;
        var osc = this.ctx.createOscillator();
        var gain = this.ctx.createGain();

        // Top of inhale: crisp high tick (1800 -> 350 Hz)
        // Bottom of exhale: warm grounding knock (1100 -> 200 Hz)
        var startFreq = isTop ? 1800 : 1100;
        var endFreq = isTop ? 350 : 200;

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(startFreq, now);
        osc.frequency.exponentialRampToValueAtTime(endFreq, now + 0.018);

        gain.gain.setValueAtTime(0.24, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.022);

        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + 0.025);
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
        osc.type = t;
        osc.frequency.setValueAtTime(f, this.ctx.currentTime);
        gain.gain.setValueAtTime(0.08, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start();
        osc.stop(this.ctx.currentTime + dur);
      } catch (e) {}
    }

    stop(immediate) {
      if (!this.masterGain || !this.ctx) return;
      var now = this.ctx.currentTime;
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

      // State diffing cache to eliminate redundant layout operations (60fps safety)
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

      // 1. Directive
      if (this.directive && (state.directive !== this._lastState.directive || state.directiveClass !== this._lastState.directiveClass)) {
        this.directive.textContent = state.directive;
        this.directive.className = state.directiveClass || 'watch-directive';
        this._lastState.directive = state.directive;
        this._lastState.directiveClass = state.directiveClass;
      }

      // 2. Coaching Hint
      if (this.hint && (state.hint !== this._lastState.hint || state.hintColor !== this._lastState.hintColor)) {
        this.hint.textContent = state.hint;
        this.hint.style.color = state.hintColor || '#ffffff';
        this._lastState.hint = state.hint;
        this._lastState.hintColor = state.hintColor;
      }

      // 3. Capsule Progress Bar
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

      // 4. Cadence Line
      if (this.cadence && (state.cadenceText !== this._lastState.cadenceText || state.cadenceColor !== this._lastState.cadenceColor)) {
        this.cadence.textContent = state.cadenceText;
        this.cadence.style.color = state.cadenceColor || '#00ffff';
        this._lastState.cadenceText = state.cadenceText;
        this._lastState.cadenceColor = state.cadenceColor;
      }

      // 5. Telemetry Line
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
      this.sessionMode = opts.sessionMode || 'TEST'; // 'TEST' | 'TRAIN'
      this.phase = 'REST'; // 'REST' | 'PACE'
      this.roundNumber = 1;
      this.totalElapsedSec = 0;
      this.phaseRemainingSec = 120;
      this.trainingDurationMin = opts.trainingDurationMin || 20;
      this.trainingRemainingSec = this.trainingDurationMin * 60;
      this.breathPhase = 0.0;
      this.baselineRsaBpm = opts.baselineRsaBpm || 10.0;
      this.latestBreathDeltaHR = 0.0;
      this.latestBreathExcursion = 0.0;
      this.completedBreathsCount = 0;
      this.breathHistory = [];
    }

    static calculateEstimatedBpm(heightCm, sex) {
      var est = (sex === 'female')
        ? (15.88 - (0.06 * heightCm))
        : (17.90 - (0.07 * heightCm));
      est = Math.max(4.5, Math.min(6.5, est));
      return (Math.round(est * 20) / 20).toFixed(2);
    }

    static calculateLungVolume(phaseNorm) {
      if (phaseNorm < 0.40) {
        return 0.5 * (1.0 - Math.cos(Math.PI * (phaseNorm / 0.40)));
      } else {
        return 0.5 * (1.0 + Math.cos(Math.PI * ((phaseNorm - 0.40) / 0.60)));
      }
    }

    static formatMMSS(sec) {
      var m = Math.floor(sec / 60).toString().padStart(2, '0');
      var s = Math.floor(sec % 60).toString().padStart(2, '0');
      return m + ':' + s;
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
        sessionMode: this.options.sessionMode || 'TEST'
      });

      this.isRunning = false;
      this.currentHR = 0;
      this.cuesEnabled = true;
      this.timerInterval = null;
      this.animFrameId = null;
      this.lastAnimTimestamp = null;
      this.lastInhaleState = false;
      this.somaticHintIndex = 0;
      this.wakeLock = null;

      // Authenticated hints matching strings.xml
      this.INHALE_HINTS = ['Through nose', 'Easily into belly', 'Normal, shallow', 'Quiet, relaxed', 'Belly out', 'Chest still'];
      this.EXHALE_HINTS = ['Relax shoulders', 'Pursed lips', 'Stay shallow', 'Relax jaw', 'Gently', 'Without force'];
      this.currentLang = 'en';
      this.strings = (window.PEAK_I18N && window.PEAK_I18N['en'] && window.PEAK_I18N['en'].strings) || {};

      this._initSimulator();
    }

    _initSimulator() {
      if (this.container) {
        var watchChassis = this.container.querySelector('.watch-chassis-wrap') || this.container;
        this.simulator = new GarminWatchSimulator(watchChassis);
      }
    }

    setLanguage(lang, customStrings) {
      this.currentLang = lang || 'en';
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
      this.engine.targetBpm = parseFloat(bpm) || 5.65;
      this.renderWatch();
    }

    setSessionMode(mode) {
      this.engine.sessionMode = mode;
      this.reset();
    }

    requestWakeLock() {
      var self = this;
      if ('wakeLock' in navigator) {
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
      if ('vibrate' in navigator) {
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

    setPhase(phase, playCues) {
      var s = this.strings;
      this.engine.phase = phase;

      if (this.engine.sessionMode === 'TRAIN') {
        this.engine.phase = 'PACE';
        this.engine.phaseRemainingSec = this.engine.trainingRemainingSec;
        if (playCues) {
          this.audio.playBeep(660, 0.4);
          this.triggerHaptic([100, 60, 100]);
        }
      } else if (phase === 'REST') {
        this.engine.phaseRemainingSec = 120;
        this.audio.stop(false);
        if (playCues) {
          this.audio.playBeep(330, 0.3);
          this.triggerHaptic([80, 50, 80]);
        }
      } else {
        this.engine.phaseRemainingSec = 120;
        this.engine.breathPhase = 0.0;
        this.lastInhaleState = false;
        if (playCues) {
          this.audio.playBeep(660, 0.4);
          this.triggerHaptic([100, 60, 100]);
        }
      }

      this.renderWatch();
      if (typeof this.options.onPhaseChange === 'function') {
        this.options.onPhaseChange({
          phase: this.engine.phase,
          roundNumber: this.engine.roundNumber
        });
      }
    }

    advancePhase() {
      if (this.engine.sessionMode === 'TRAIN') {
        this.completeSession();
        return;
      }
      if (this.engine.phase === 'REST') {
        this.setPhase('PACE', true);
      } else {
        this.engine.roundNumber++;
        this.setPhase('REST', true);
      }
    }

    completeSession() {
      this.pause();
      this.triggerHaptic([150, 100, 150, 100, 250]);
      this.audio.playBeep(880, 0.6);
      if (typeof this.options.onSessionComplete === 'function') {
        this.options.onSessionComplete({
          durationMin: this.engine.trainingDurationMin,
          completedBreaths: this.engine.completedBreathsCount,
          breathHistory: this.engine.breathHistory
        });
      }
    }

    start() {
      if (this.isRunning) return;
      this.audio.init();
      this.requestWakeLock();
      this.isRunning = true;
      var self = this;

      if (!this.timerInterval) {
        this.timerInterval = setInterval(function () {
          self.tick();
        }, 1000);
        this.animFrameId = requestAnimationFrame(function (ts) {
          self.updateVisualLoop(ts);
        });
      }
    }

    pause() {
      if (!this.isRunning) return;
      this.isRunning = false;
      this.lastAnimTimestamp = null;
      this.releaseWakeLock();
      this.audio.stop(false);

      clearInterval(this.timerInterval);
      cancelAnimationFrame(this.animFrameId);
      this.timerInterval = null;
      this.animFrameId = null;

      this.renderWatch();
    }

    reset() {
      this.pause();
      this.audio.stop(true);
      this.engine.roundNumber = 1;
      this.engine.totalElapsedSec = 0;
      this.engine.breathPhase = 0.0;
      this.lastAnimTimestamp = null;
      this.lastInhaleState = false;
      this.engine.trainingRemainingSec = this.engine.trainingDurationMin * 60;
      this.engine.completedBreathsCount = 0;
      this.engine.breathHistory = [];
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

    tick() {
      this.engine.totalElapsedSec++;
      if (this.engine.sessionMode === 'TRAIN') {
        this.engine.trainingRemainingSec = Math.max(0, this.engine.trainingRemainingSec - 1);
        this.engine.phaseRemainingSec = this.engine.trainingRemainingSec;
        if (this.engine.trainingRemainingSec <= 0) {
          this.completeSession();
          return;
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
          roundNumber: this.engine.roundNumber
        });
      }
    }

    renderWatch() {
      if (!this.simulator) return;
      var s = this.strings;
      var bpm = this.engine.targetBpm;
      var hrTxt = s.hr_label || 'HR';
      var state = {};

      if (!this.isRunning && this.engine.totalElapsedSec === 0) {
        state.directive = s.AppName || 'PEAK FREQUENCY';
        state.directiveClass = 'watch-directive';
        state.hint = s.prompt || 'Tap Start Below';
        state.hintColor = '#e2e8f0';
        state.showBar = this.engine.sessionMode === 'TRAIN';
        state.fillPct = '0';
        if (this.engine.sessionMode === 'TRAIN') {
          state.cadenceText = 'Resonance: ' + bpm.toFixed(2) + ' BPM';
          state.cadenceColor = '#00ffff';
          state.telemetryText = hrTxt + ': ' + this.getActiveHRDisplay() + ' | ' + this.engine.trainingDurationMin + 'm left';
        } else {
          var rTxt = s.round_prefix || 'R';
          var centerTxt = s.leg_center || 'Center';
          var unitTxt = s.bpm_unit || 'BPM';
          state.cadenceText = rTxt + '1 ' + centerTxt + ': ' + bpm.toFixed(2) + ' ' + unitTxt;
          state.cadenceColor = '#00ffff';
          var secLeftTxt = s.seconds_left || 's left';
          state.telemetryText = hrTxt + ': ' + this.getActiveHRDisplay() + ' | 120 ' + secLeftTxt;
        }
      } else if (!this.isRunning && this.engine.totalElapsedSec > 0) {
        state.directive = (s.session_paused || 'PAUSED').toUpperCase();
        state.directiveClass = 'watch-directive rest';
        state.hint = s.start_continue ? s.start_continue.replace(/[[\]]/g, '') : 'Session paused';
        state.hintColor = '#fbbf24';
        state.showBar = false;
        state.fillPct = '0';
        state.cadenceText = 'Resonance: ' + bpm.toFixed(2) + ' BPM';
        state.cadenceColor = '#00ffff';
        state.telemetryText = hrTxt + ': ' + this.getActiveHRDisplay() + ' | ' + Math.max(0, this.engine.phaseRemainingSec) + 's left';
      } else if (this.engine.phase === 'REST' && this.engine.sessionMode === 'TEST') {
        state.directive = (s.rest_baseline_title || 'REST BASELINE').toUpperCase();
        state.directiveClass = 'watch-directive rest';
        state.hint = s.breathe_naturally || 'Breathe naturally';
        state.hintColor = '#94a3b8';
        state.showBar = false;
        state.fillPct = '0';
        var nextTxt = s.next_prefix || 'Next';
        var rPrefix = s.round_prefix || 'R';
        var cTxt = s.leg_center || 'Center';
        state.cadenceText = nextTxt + ': ' + rPrefix + this.engine.roundNumber + ' ' + cTxt + ' ' + bpm.toFixed(2);
        state.cadenceColor = '#22c55e';
        var sLeftTxt = s.seconds_left || 's left';
        state.telemetryText = hrTxt + ': ' + this.getActiveHRDisplay() + ' | ' + Math.max(0, this.engine.phaseRemainingSec) + ' ' + sLeftTxt;
      }
      this.simulator.render(state);
    }

    updateVisualLoop(timestamp) {
      if (!this.isRunning) return;

      if (this.lastAnimTimestamp === null) {
        this.lastAnimTimestamp = timestamp;
      }
      var dtMs = Math.min(100, Math.max(0, timestamp - this.lastAnimTimestamp));
      this.lastAnimTimestamp = timestamp;

      var s = this.strings;
      var bpm = this.engine.targetBpm;
      var hrTxt = s.hr_label || 'HR';

      if (this.engine.phase === 'REST' && this.engine.sessionMode === 'TEST') {
        // In rest mode, state is static during frames
        this.renderWatch();
      } else {
        // Active pacing
        this.audio.start();
        var cycleDurationMs = (60.0 / bpm) * 1000;
        var prevBreathPhase = this.engine.breathPhase;
        this.engine.breathPhase = (this.engine.breathPhase + (dtMs / cycleDurationMs)) % 1.0;
        var cycleProgress = this.engine.breathPhase;

        // Wrap-around cycle completion detection
        if (cycleProgress < prevBreathPhase) {
          this.engine.completedBreathsCount++;
          if (typeof this.options.onBreathCycle === 'function') {
            this.options.onBreathCycle({
              breathIndex: this.engine.completedBreathsCount,
              currentHR: this.currentHR
            });
          }
        }

        var isInhale = cycleProgress < 0.40;
        var phaseFactor, phaseProgress;
        if (isInhale) {
          phaseProgress = cycleProgress / 0.40;
          phaseFactor = 0.5 - 0.5 * Math.cos(phaseProgress * Math.PI);
        } else {
          phaseProgress = (cycleProgress - 0.40) / 0.60;
          phaseFactor = 0.5 + 0.5 * Math.cos(phaseProgress * Math.PI);
        }

        var pulseSine = Math.sin(phaseProgress * 4 * Math.PI);
        var pulseModulation = 0.78 + 0.22 * Math.abs(pulseSine);

        var fillFraction = isInhale ? phaseProgress : (1.0 - phaseProgress);
        var fillPct = (fillFraction * 100).toFixed(1);

        // Turnaround clicks
        if (isInhale && !this.lastInhaleState) {
          this.audio.playClick(false); // Bottom click (Exhale -> Inhale)
          this.triggerHaptic(50);
          this.lastInhaleState = true;
        } else if (!isInhale && this.lastInhaleState) {
          this.audio.playClick(true); // Peak click (Inhale -> Exhale)
          this.triggerHaptic([30, 40, 30]);
          this.lastInhaleState = false;
          this.somaticHintIndex++;
        }

        // Audio synthesis update
        this.audio.updateFrame(isInhale, phaseFactor, pulseModulation);

        // Render to watch with state diffing
        var watchState = {
          directive: isInhale ? (s.pacer_inhale || 'BREATHE IN') : (s.pacer_exhale || 'BREATHE OUT'),
          directiveClass: isInhale ? 'watch-directive' : 'watch-directive exhale',
          hint: isInhale
            ? this.INHALE_HINTS[this.somaticHintIndex % this.INHALE_HINTS.length]
            : this.EXHALE_HINTS[this.somaticHintIndex % this.EXHALE_HINTS.length],
          hintColor: '#ffffff',
          showBar: true,
          fillPct: fillPct,
          fillClass: isInhale ? 'watch-bar-fill' : 'watch-bar-fill exhale'
        };

        if (this.engine.sessionMode === 'TRAIN') {
          watchState.cadenceText = 'Resonance: ' + bpm.toFixed(2) + ' BPM';
          watchState.cadenceColor = '#00ffff';
          var mLeft = Math.ceil(this.engine.phaseRemainingSec / 60);
          var minTxt = s.minutes_left || 'm left';
          watchState.telemetryText = hrTxt + ': ' + this.getActiveHRDisplay() + ' | ' + mLeft + ' ' + minTxt;
        } else {
          var rPrefix = s.round_prefix || 'R';
          var centerTxt = s.leg_center || 'Center';
          var unitTxt = s.bpm_unit || 'BPM';
          watchState.cadenceText = rPrefix + this.engine.roundNumber + ' ' + centerTxt + ': ' + bpm.toFixed(2) + ' ' + unitTxt;
          watchState.cadenceColor = '#00ffff';
          var secLeftTxt = s.seconds_left || 's left';
          watchState.telemetryText = hrTxt + ': ' + this.getActiveHRDisplay() + ' | ' + Math.max(0, this.engine.phaseRemainingSec) + ' ' + secLeftTxt;
        }

        this.simulator.render(watchState);
      }

      var self = this;
      this.animFrameId = requestAnimationFrame(function (ts) {
        self.updateVisualLoop(ts);
      });
    }
  }

  return {
    GarminPacer: GarminPacer,
    BreathAudioSynth: BreathAudioSynth,
    GarminWatchSimulator: GarminWatchSimulator,
    PacerEngine: PacerEngine
  };
});
