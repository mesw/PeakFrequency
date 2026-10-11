/**
 * ANT+ WebUSB Driver & Real-Time Biometrics Canvas Engine
 * Peak Frequency — HRV Resonance Breath Pacer for Garmin
 *
 * Implements:
 * 1. Hardware WebUSB ANT+ HRM Driver (0xA4 Deframer, XOR Checksum, 16-bit Rollover Arithmetic)
 * 2. Authentic 4.06 Hz Physiological ANT+ Simulation with Respiratory Sinus Arrhythmia (RSA)
 * 3. Digital Signal Processing (DSP): Rolling RMSSD, Cross-Correlation Phase Synchrony
 * 4. Moving 60-Second Frequency Analysis (80-Bin DFT with Hanning Window & LF Coherence Ratio)
 * 5. High-DPI Canvas Rendering Suite: Cardiotachometer, 24-LED Light-Bar, FFT Spectrum & Sparklines
 * 6. Dual Export Pattern (window.AntBiometricsController / module.exports)
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    var exports = factory();
    root.AntBiometricsController = exports.AntBiometricsController;
    root.AntHrmDriver = exports.AntHrmDriver;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ANT_VID = 0x0FCF; // Garmin / Dynastream USB Sticks (USB2, USB-m)
  const ANT_PUBLIC_NETWORK_KEY = [0xB9, 0xA5, 0x21, 0xFB, 0xBD, 0x72, 0xC3, 0x45];
  const HRM_DEVICE_TYPE = 120;
  const HRM_CHANNEL_PERIOD = 8070; // ~4.06 Hz
  const HRM_RF_FREQ = 57; // 2457 MHz

  // =========================================================================
  // 1. HARDWARE WEBUSB ANT+ DRIVER
  // =========================================================================
  class AntHrmDriver {
    constructor(callbacks) {
      this.callbacks = callbacks || {};
      this.device = null;
      this.isRunning = false;
      this.inBuffer = [];
      this.prevBeatCount = null;
      this.prevEventTime = null;
    }

    static buildPacket(msgId, data) {
      const packet = [0xA4, data.length, msgId, ...data];
      let checksum = 0;
      for (let i = 0; i < packet.length; i++) checksum ^= packet[i];
      packet.push(checksum);
      return new Uint8Array(packet);
    }

    async sendCmd(msgId, data) {
      if (!this.device || !this.device.opened) return;
      const packet = AntHrmDriver.buildPacket(msgId, data);
      await this.device.transferOut(1, packet);
    }

    async initRadioChannel() {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      await this.sendCmd(0x4A, [0x00]); await sleep(500); // Reset System
      await this.sendCmd(0x46, [0x00, ...ANT_PUBLIC_NETWORK_KEY]); await sleep(50); // Network Key
      await this.sendCmd(0x42, [0x00, 0x00, 0x00]); await sleep(50); // Assign Ch 0
      await this.sendCmd(0x51, [0x00, 0x00, 0x00, HRM_DEVICE_TYPE, 0x00]); await sleep(50); // Set Ch ID
      await this.sendCmd(0x45, [0x00, HRM_RF_FREQ]); await sleep(50); // 2457 MHz
      await this.sendCmd(0x43, [0x00, HRM_CHANNEL_PERIOD & 0xFF, (HRM_CHANNEL_PERIOD >> 8) & 0xFF]); await sleep(50); // 4.06 Hz
      await this.sendCmd(0x44, [0x00, 255]); await sleep(50); // Search Timeout
      await this.sendCmd(0x4B, [0x00]); // Open Channel
    }

    async connect() {
      if (!navigator.usb) throw new Error('WebUSB not supported');
      this.device = await navigator.usb.requestDevice({ filters: [{ vendorId: ANT_VID }] });
      await this.device.open();
      if (this.device.configuration === null) await this.device.selectConfiguration(1);
      await this.device.claimInterface(0);

      await this.initRadioChannel();
      this.isRunning = true;
      this.readUsbLoop();
    }

    async disconnect() {
      this.isRunning = false;
      if (this.device) {
        try { await this.device.close(); } catch (e) {}
        this.device = null;
      }
      this.prevBeatCount = null;
      this.prevEventTime = null;
      this.inBuffer = [];
    }

    async readUsbLoop() {
      while (this.isRunning && this.device && this.device.opened) {
        try {
          const res = await this.device.transferIn(1, 64);
          if (res.status !== 'ok' || !res.data || res.data.byteLength === 0) {
            await new Promise((r) => setTimeout(r, 10));
            continue;
          }
          const view = res.data;
          for (let i = 0; i < view.byteLength; i++) this.inBuffer.push(view.getUint8(i));

          while (this.inBuffer.length >= 4) {
            if (this.inBuffer[0] !== 0xA4) {
              this.inBuffer.shift();
              continue;
            }
            const msgLen = this.inBuffer[1];
            const totalLen = msgLen + 4;
            if (this.inBuffer.length < totalLen) break;

            const packet = this.inBuffer.splice(0, totalLen);
            let chk = 0;
            for (let i = 0; i < packet.length; i++) chk ^= packet[i];
            if (chk !== 0) continue; // Checksum mismatch

            const msgId = packet[2];
            const payload = packet.slice(3, -1);
            if (msgId === 0x4E && payload.length >= 9) {
              this.parseHrmPayload(payload.slice(1, 9));
            }
          }
        } catch (e) {
          if (this.isRunning) await new Promise((r) => setTimeout(r, 40));
        }
      }
    }

    parseHrmPayload(data) {
      const now = performance.now() / 1000.0;
      const eventTime = data[4] | (data[5] << 8);
      const beatCount = data[6];
      const hr = data[7];
      let rrMs = 0;

      if (this.prevBeatCount !== null && this.prevEventTime !== null) {
        const beatDiff = (beatCount - this.prevBeatCount) & 0xFF;
        if (beatDiff > 0) {
          const timeDiff = (eventTime - this.prevEventTime) & 0xFFFF;
          const rawRr = (timeDiff * 1000.0 / 1024.0) / beatDiff;
          if (rawRr >= 300.0 && rawRr <= 1500.0) {
            rrMs = rawRr;
          }
        }
      }

      this.prevBeatCount = beatCount;
      this.prevEventTime = eventTime;

      if (typeof this.callbacks.onPayload === 'function') {
        this.callbacks.onPayload({ hr, rrMs, beatCount, eventTime, timestamp: now });
      }
    }
  }

  // =========================================================================
  // 2. UNIFIED ANT+ BIOMETRICS & CANVAS CONTROLLER
  // =========================================================================
  class AntBiometricsController {
    constructor(options) {
      this.options = options || {};
      this.container = typeof this.options.container === 'string'
        ? document.querySelector(this.options.container)
        : (this.options.container || document);
      if (!this.container) this.container = document;
      this.pacer = this.options.pacer || null;

      // Drivers & State
      this.driver = new AntHrmDriver({
        onPayload: (data) => this.handlePayload(data)
      });
      this.antRunning = false;
      this.isSimulatingAnt = false;
      this.simInterval = null;

      this.currentHR = 0;
      this.currentRR = 0;
      this.currentRMSSD = 0;
      this.currentPhaseLagMs = 0;
      this.currentPhaseDeg = 0;

      // Simulation State
      this.simBeatCount = 0;
      this.simEventTime = 0;

      // Buffers & Histories
      this.HISTORY_LEN = 160;
      this.hrHistory = [];
      this.rrHistory = [];
      this.rmssdHistory = [];
      this.rrWindow = []; // 30-beat moving window for RMSSD
      this.sessionLogs = []; // JSONL session history

      this.SYNC_HISTORY_LEN = 140;
      this.syncWaveformBuffer = [];

      this.rollingHrWindow = []; // 60s moving window for FFT
      this.fftSpectrumBins = [];
      this.peakSpectralFreq = 0.0;
      this.peakSpectralPower = 0.0;
      this.lfPowerRatio = 0.0;

      // Light-Bar State
      this.lightBarAnimExcursion = 0.0;
      this.lightBarPeakHoldVal = 0.0;
      this.lightBarPeakHoldDecay = 0;
      this.latestBreathExcursion = 0.0;
      this.baselineRsaBpm = this.options.baselineRsaBpm || 10.0;

      this.animFrameId = null;

      this._initDom();
      this._initCanvases();
      this._bindEvents();
    }

    _initDom() {
      const c = this.container;
      this.dom = {
        antChartsCollapse: c.querySelector('#antChartsCollapse'),
        btnConnectAnt: c.querySelector('#btnConnectAnt'),
        btnConnectAntText: c.querySelector('#btnConnectAntText'),
        btnSimulateAnt: c.querySelector('#btnSimulateAnt'),
        btnSimulateText: c.querySelector('#btnSimulateText'),
        btnExportJsonl: c.querySelector('#btnExportJsonl'),
        valHR: c.querySelector('#valHR'),
        valRR: c.querySelector('#valRR'),
        valRMSSD: c.querySelector('#valRMSSD'),
        valPhaseLag: c.querySelector('#valPhaseLag'),
        valRSA: c.querySelector('#valRSA'),
        antStatusDot: c.querySelector('#antStatusDot'),
        lblAntStatus: c.querySelector('#lblAntStatus'),
        lbDeltaHrVal: c.querySelector('#lbDeltaHrVal'),
        lbExcursionVal: c.querySelector('#lbExcursionVal'),
        lbHrExtremes: c.querySelector('#lbHrExtremes'),
        badgeExcursionGoal: c.querySelector('#badgeExcursionGoal'),
        fftReadout: c.querySelector('#fftReadout'),
        syncCanvas: c.querySelector('#syncCanvas'),
        lightBarCanvas: c.querySelector('#lightBarCanvas'),
        fftCanvas: c.querySelector('#fftCanvas'),
        sparkHrCanvas: c.querySelector('#sparkHrCanvas'),
        sparkRrCanvas: c.querySelector('#sparkRrCanvas'),
        sparkRmssdCanvas: c.querySelector('#sparkRmssdCanvas')
      };
    }

    _initCanvases() {
      const d = this.dom;
      this.syncCtx = d.syncCanvas ? d.syncCanvas.getContext('2d') : null;
      this.lightBarCtx = d.lightBarCanvas ? d.lightBarCanvas.getContext('2d') : null;
      this.fftCtx = d.fftCanvas ? d.fftCanvas.getContext('2d') : null;
      this.sparkHrCtx = d.sparkHrCanvas ? d.sparkHrCanvas.getContext('2d') : null;
      this.sparkRrCtx = d.sparkRrCanvas ? d.sparkRrCanvas.getContext('2d') : null;
      this.sparkRmssdCtx = d.sparkRmssdCanvas ? d.sparkRmssdCanvas.getContext('2d') : null;

      this.resizeCanvases();
      window.addEventListener('resize', () => this.resizeCanvases());
    }

    _bindEvents() {
      const d = this.dom;
      if (d.btnConnectAnt) d.btnConnectAnt.addEventListener('click', () => this.toggleConnect());
      if (d.btnSimulateAnt) d.btnSimulateAnt.addEventListener('click', () => this.toggleSimulation());
      if (d.btnExportJsonl) d.btnExportJsonl.addEventListener('click', () => this.exportJsonl());

      if (navigator.usb) {
        navigator.usb.addEventListener('disconnect', (event) => {
          if (this.driver.device && event.device === this.driver.device) {
            this.resetAntState('ANT+ Stick getrennt / disconnected.');
          }
        });
      }
    }

    static setupCanvasDpi(canvas, ctx, logicalW, logicalH) {
      if (!canvas || !ctx) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = logicalW * dpr;
      canvas.height = logicalH * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    resizeCanvases() {
      const d = this.dom;
      if (d.syncCanvas && this.syncCtx) AntBiometricsController.setupCanvasDpi(d.syncCanvas, this.syncCtx, 520, 210);
      if (d.lightBarCanvas && this.lightBarCtx) AntBiometricsController.setupCanvasDpi(d.lightBarCanvas, this.lightBarCtx, 160, 210);
      if (d.fftCanvas && this.fftCtx) AntBiometricsController.setupCanvasDpi(d.fftCanvas, this.fftCtx, 700, 175);
      if (d.sparkHrCanvas && this.sparkHrCtx) AntBiometricsController.setupCanvasDpi(d.sparkHrCanvas, this.sparkHrCtx, 220, 75);
      if (d.sparkRrCanvas && this.sparkRrCtx) AntBiometricsController.setupCanvasDpi(d.sparkRrCanvas, this.sparkRrCtx, 220, 75);
      if (d.sparkRmssdCanvas && this.sparkRmssdCtx) AntBiometricsController.setupCanvasDpi(d.sparkRmssdCanvas, this.sparkRmssdCtx, 220, 75);
      this.renderVisuals();
    }

    updateStatus(text, color = '#ffd600', isLive = false) {
      if (this.dom.lblAntStatus) {
        this.dom.lblAntStatus.textContent = text;
        this.dom.lblAntStatus.style.color = color;
      }
      if (this.dom.antStatusDot) {
        this.dom.antStatusDot.style.background = isLive ? '#00ff66' : (color === '#ff3366' ? '#ff3366' : '#ffd600');
        this.dom.antStatusDot.classList.toggle('live', isLive);
      }
    }

    setConnectedVisibility(connected) {
      if (!connected) {
        this.currentHR = 0;
        this.currentRR = 0;
        if (this.pacer) this.pacer.setHeartRate(0);
        if (this.dom.valHR) this.dom.valHR.innerHTML = '-- <small>BPM</small>';
        if (this.dom.valRR) this.dom.valRR.innerHTML = '-- <small>ms</small>';
      }
      if (this.dom.antChartsCollapse) {
        this.dom.antChartsCollapse.style.display = connected ? 'flex' : 'none';
      }
      if (connected) {
        this.resizeCanvases();
      }
    }

    resetAntState(reasonText) {
      this.antRunning = false;
      this.driver.disconnect();
      this.currentHR = 0;
      this.currentRR = 0;
      if (this.pacer) this.pacer.setHeartRate(0);

      if (this.dom.valHR) this.dom.valHR.innerHTML = '-- <small>BPM</small>';
      if (this.dom.valRR) this.dom.valRR.innerHTML = '-- <small>ms</small>';
      if (this.dom.btnConnectAntText) {
        const s = (this.pacer && this.pacer.strings) || (window.PEAK_I18N && window.PEAK_I18N[document.documentElement.lang || 'en'] && window.PEAK_I18N[document.documentElement.lang || 'en'].strings) || {};
        this.dom.btnConnectAntText.textContent = s.ant_btn_connect || '🔌 Connect ANT+ Stick';
      }
      if (this.dom.btnConnectAnt) this.dom.btnConnectAnt.classList.remove('active');
      if (reasonText) this.updateStatus(reasonText, '#94a3b8', false);
      this.setConnectedVisibility(this.isSimulatingAnt);
    }

    async toggleConnect() {
      if (this.antRunning) {
        this.resetAntState('ANT+ Stick getrennt / disconnected.');
        return;
      }
      if (this.isSimulatingAnt) this.stopSimulation();

      this.updateStatus('Bitte ANT+ USB-Stick im Popup wählen / Select ANT+ Stick in popup...', '#00e5ff', false);
      try {
        await this.driver.connect();
        this.antRunning = true;
        if (this.dom.btnConnectAntText) this.dom.btnConnectAntText.textContent = '✓ ANT+ Connected';
        if (this.dom.btnConnectAnt) this.dom.btnConnectAnt.classList.add('active');
        this.updateStatus('ANT+ aktiv! Suche HRM auf 2457 MHz / Searching for HRM...', '#00ff66', true);
        this.setConnectedVisibility(true);
        this.ensureAnimLoop();
      } catch (err) {
        this.resetAntState();
        const msg = err.message || err.toString();
        if (msg.includes('No device selected') || msg.includes('cancelled')) {
          this.updateStatus('Auswahl abgebrochen / Pairing cancelled.', '#94a3b8', false);
        } else {
          this.updateStatus(`WebUSB Fehler: ${msg}. If on Windows, install WinUSB via Zadig.`, '#ff3366', false);
        }
      }
    }

    // 4.06 Hz Physiological Simulation
    startSimulation() {
      if (this.isSimulatingAnt) return;
      if (this.antRunning) this.toggleConnect();

      this.isSimulatingAnt = true;
      this.simBeatCount = 0;
      this.simEventTime = 0;
      this.setConnectedVisibility(true);

      if (this.dom.btnSimulateText) this.dom.btnSimulateText.textContent = '⏹ Stop Simulation';
      if (this.dom.btnSimulateAnt) this.dom.btnSimulateAnt.classList.add('active');
      this.updateStatus('⚡ Live-Simulation: 4.06 Hz ANT+ HRM mit Resonanz-RSA', '#00ff66', true);

      const PACKET_INTERVAL_MS = 246;
      let lastBeatEventSec = performance.now() / 1000.0;
      let simLastTime = performance.now() / 1000.0;
      let simLungPhase = 0.0;

      this.simInterval = setInterval(() => {
        const now = performance.now() / 1000.0;
        const dtSim = Math.min(0.5, Math.max(0, now - simLastTime));
        simLastTime = now;

        const bpmTarget = (this.pacer && this.pacer.engine) ? this.pacer.engine.targetBpm : 5.65;
        simLungPhase = (simLungPhase + dtSim * (bpmTarget / 60.0)) % 1.0;

        // Respiration volume cosine easing
        let lungVol = 0;
        if (simLungPhase < 0.40) {
          lungVol = 0.5 * (1.0 - Math.cos(Math.PI * (simLungPhase / 0.40)));
        } else {
          lungVol = 0.5 * (1.0 + Math.cos(Math.PI * ((simLungPhase - 0.40) / 0.60)));
        }

        const baseHR = 76;
        const deltaHR = (this.pacer && this.pacer.engine && this.pacer.engine.sessionMode === 'TRAIN') ? 9.8 : 7.5;
        const noiseBpm = (Math.random() - 0.5) * 1.5;
        const currentSimHR = Math.round(baseHR + deltaHR * (lungVol * 2.0 - 1.0) + noiseBpm);
        const instantRRSec = 60.0 / currentSimHR;

        if (now - lastBeatEventSec >= instantRRSec) {
          lastBeatEventSec = now;
          this.simBeatCount = (this.simBeatCount + 1) & 0xFF;
          const eventDelta1024 = Math.round(instantRRSec * 1024.0);
          this.simEventTime = (this.simEventTime + eventDelta1024) & 0xFFFF;
        }

        const simPayload = [
          0x00, 0xFF, 0xFF, 0x01,
          this.simEventTime & 0xFF,
          (this.simEventTime >> 8) & 0xFF,
          this.simBeatCount,
          currentSimHR
        ];
        this.driver.parseHrmPayload(simPayload);
      }, PACKET_INTERVAL_MS);

      this.ensureAnimLoop();
    }

    stopSimulation() {
      if (!this.isSimulatingAnt) return;
      this.isSimulatingAnt = false;
      if (this.simInterval) {
        clearInterval(this.simInterval);
        this.simInterval = null;
      }
      if (this.dom.btnSimulateText) {
        const s = (this.pacer && this.pacer.strings) || (window.PEAK_I18N && window.PEAK_I18N[document.documentElement.lang || 'en'] && window.PEAK_I18N[document.documentElement.lang || 'en'].strings) || {};
        this.dom.btnSimulateText.textContent = s.ant_btn_simulate || '⚡ Live Simulation';
      }
      if (this.dom.btnSimulateAnt) this.dom.btnSimulateAnt.classList.remove('active');
      this.resetAntState('Simulation stopped. Ready for ANT+ USB Stick or Simulation.');
    }

    toggleSimulation() {
      if (this.isSimulatingAnt) this.stopSimulation();
      else this.startSimulation();
    }

    handlePayload(data) {
      const { hr, rrMs, beatCount, eventTime, timestamp } = data;
      if (hr > 0 || rrMs > 0) {
        this.updateStatus(
          `ANT+ Sync OK | BeatCount: ${beatCount} | EventTime: ${eventTime} | RR: ${rrMs > 0 ? rrMs.toFixed(1) + ' ms' : '--'}`,
          '#00ff66',
          true
        );
      }
      this.processMetrics(hr, rrMs, timestamp);
    }

    processMetrics(hr, rrMs, timestamp) {
      if (hr > 0) {
        this.currentHR = hr;
        if (this.pacer) this.pacer.setHeartRate(hr);
        this.hrHistory.push(hr);
        if (this.hrHistory.length > this.HISTORY_LEN) this.hrHistory.shift();
        if (this.dom.valHR) this.dom.valHR.innerHTML = `${hr} <small>BPM</small>`;

        this.rollingHrWindow.push({ t: timestamp, hr: hr });
        while (this.rollingHrWindow.length > 0 && (timestamp - this.rollingHrWindow[0].t) > 60.0) {
          this.rollingHrWindow.shift();
        }
      }

      let isNewBeat = false;
      if (rrMs > 0) {
        isNewBeat = true;
        this.currentRR = rrMs;
        this.rrHistory.push(rrMs);
        if (this.rrHistory.length > this.HISTORY_LEN) this.rrHistory.shift();
        if (this.dom.valRR) this.dom.valRR.innerHTML = `${rrMs.toFixed(1)} <small>ms</small>`;

        this.rrWindow.push(rrMs);
        if (this.rrWindow.length > 30) this.rrWindow.shift();

        if (this.rrWindow.length >= 2) {
          let sumSqDiff = 0;
          for (let i = 0; i < this.rrWindow.length - 1; i++) {
            const diff = this.rrWindow[i + 1] - this.rrWindow[i];
            sumSqDiff += diff * diff;
          }
          this.currentRMSSD = Math.sqrt(sumSqDiff / (this.rrWindow.length - 1));
        } else {
          this.currentRMSSD = 0;
        }

        this.rmssdHistory.push(this.currentRMSSD);
        if (this.rmssdHistory.length > this.HISTORY_LEN) this.rmssdHistory.shift();
        if (this.dom.valRMSSD) this.dom.valRMSSD.innerHTML = `${this.currentRMSSD.toFixed(1)} <small>ms</small>`;
      }

      const bpmTarget = (this.pacer && this.pacer.engine) ? this.pacer.engine.targetBpm : 5.65;
      const isRunning = this.pacer && this.pacer.isRunning;
      const currentPhase = this.pacer ? this.pacer.engine.phase : 'REST';
      const breathPhase = this.pacer ? this.pacer.engine.breathPhase : 0.0;

      let currentPhaseNorm = (isRunning && currentPhase === 'PACE')
        ? breathPhase
        : ((timestamp * (bpmTarget / 60.0)) % 1.0);

      // Instantaneous Respiration volume [-1.0 .. +1.0]
      let respVol = 0;
      if (currentPhaseNorm < 0.40) {
        respVol = 0.5 * (1.0 - Math.cos(Math.PI * (currentPhaseNorm / 0.40)));
      } else {
        respVol = 0.5 * (1.0 + Math.cos(Math.PI * ((currentPhaseNorm - 0.40) / 0.60)));
      }
      const respNormalized = respVol * 2.0 - 1.0;

      this.syncWaveformBuffer.push({
        t: timestamp,
        resp: respNormalized,
        hr: this.currentHR,
        rr: this.currentRR,
        isBeat: isNewBeat
      });
      if (this.syncWaveformBuffer.length > this.SYNC_HISTORY_LEN) this.syncWaveformBuffer.shift();

      if (this.syncWaveformBuffer.length >= 30) {
        this.estimatePhaseLag(bpmTarget);
      }

      this.sessionLogs.push({
        timestamp: Math.round(timestamp * 1000) / 1000,
        hr: this.currentHR,
        rr_ms: Math.round(this.currentRR * 10) / 10,
        rmssd: Math.round(this.currentRMSSD * 10) / 10,
        target_bpm: bpmTarget,
        protocol_state: isRunning ? currentPhase : 'MONITOR',
        respiration_vol: Math.round(respVol * 1000) / 1000,
        phase_lag_ms: Math.round(this.currentPhaseLagMs)
      });
      if (this.sessionLogs.length > 20000) this.sessionLogs.shift();
    }

    estimatePhaseLag(bpmTarget) {
      const N = this.syncWaveformBuffer.length;
      if (N < 20) return;

      let sumHR = 0;
      for (let i = 0; i < N; i++) sumHR += this.syncWaveformBuffer[i].hr;
      const meanHR = sumHR / N;

      const MAX_LAG = 12;
      let bestLag = 0, maxCorr = -Infinity;

      for (let lag = -MAX_LAG; lag <= MAX_LAG; lag++) {
        let corr = 0, count = 0;
        for (let i = 0; i < N; i++) {
          const j = i + lag;
          if (j >= 0 && j < N) {
            const hrDetrend = this.syncWaveformBuffer[j].hr - meanHR;
            corr += hrDetrend * this.syncWaveformBuffer[i].resp;
            count++;
          }
        }
        if (count > 0) {
          corr /= count;
          if (corr > maxCorr) {
            maxCorr = corr;
            bestLag = lag;
          }
        }
      }

      const dt = (this.syncWaveformBuffer[N - 1].t - this.syncWaveformBuffer[0].t) / (N - 1);
      const lagSec = bestLag * dt;
      this.currentPhaseLagMs = Math.round(lagSec * 1000);

      const targetFreqHz = bpmTarget / 60.0;
      let deg = Math.abs(lagSec * targetFreqHz * 360.0) % 360.0;
      if (deg > 180.0) deg = 360.0 - deg;
      this.currentPhaseDeg = Math.round(deg);

      if (this.dom.valPhaseLag) {
        const sign = this.currentPhaseLagMs >= 0 ? '+' : '';
        if (this.currentPhaseDeg <= 25) {
          this.dom.valPhaseLag.innerHTML = `<span style="color:#00ff66;">${this.currentPhaseLagMs} ms (0° Sync)</span>`;
        } else {
          this.dom.valPhaseLag.innerHTML = `${sign}${this.currentPhaseLagMs} <small>ms (${this.currentPhaseDeg}°)</small>`;
        }
      }
    }

    calculateFftSpectrum() {
      const N = this.rollingHrWindow.length;
      if (N < 20) {
        this.fftSpectrumBins = [];
        this.peakSpectralFreq = 0.0;
        this.peakSpectralPower = 0.0;
        this.lfPowerRatio = 0.0;
        if (this.dom.fftReadout) {
          const sec = this.rollingHrWindow.length > 0 ? Math.round(this.rollingHrWindow[this.rollingHrWindow.length - 1].t - this.rollingHrWindow[0].t) : 0;
          this.dom.fftReadout.textContent = `Accumulating 60s signal buffer (${sec}s / 60s)...`;
        }
        return;
      }

      let sumHr = 0;
      for (let i = 0; i < N; i++) sumHr += this.rollingHrWindow[i].hr;
      const meanHr = sumHr / N;

      const NUM_BINS = 80;
      const fMin = 0.005, fMax = 0.400;
      const bins = [];
      let maxPwr = 0.0, bestFreq = 0.0, sumVlf = 0.0, sumLf = 0.0, sumHf = 0.0;
      const t0 = this.rollingHrWindow[0].t;

      for (let b = 0; b < NUM_BINS; b++) {
        const freq = fMin + (b / (NUM_BINS - 1)) * (fMax - fMin);
        let realSum = 0, imagSum = 0;

        for (let i = 0; i < N; i++) {
          const dt = this.rollingHrWindow[i].t - t0;
          const hanning = 0.5 * (1.0 - Math.cos((2.0 * Math.PI * i) / (N - 1)));
          const val = (this.rollingHrWindow[i].hr - meanHr) * hanning;
          const angle = 2.0 * Math.PI * freq * dt;
          realSum += val * Math.cos(angle);
          imagSum += val * Math.sin(angle);
        }

        const pwr = (realSum * realSum + imagSum * imagSum) / N;
        bins.push({ freq, pwr });

        if (pwr > maxPwr) {
          maxPwr = pwr;
          bestFreq = freq;
        }

        if (freq < 0.04) sumVlf += pwr;
        else if (freq <= 0.15) sumLf += pwr;
        else sumHf += pwr;
      }

      this.fftSpectrumBins = bins;
      this.peakSpectralFreq = bestFreq;
      this.peakSpectralPower = maxPwr;
      const totalPwr = sumLf + sumHf + 0.0001;
      this.lfPowerRatio = Math.min(1.0, Math.max(0.0, sumLf / totalPwr));

      if (this.dom.fftReadout) {
        const peakBpm = (bestFreq * 60.0).toFixed(1);
        const lfPct = Math.round(this.lfPowerRatio * 100);
        this.dom.fftReadout.textContent = `Peak: ${bestFreq.toFixed(3)} Hz (${peakBpm} BPM) | LF Coherence: ${lfPct}% | Resonance Power: ${Math.round(maxPwr)} ms²/Hz`;
      }
    }

    ensureAnimLoop() {
      if (!this.animFrameId) {
        this.animFrameId = requestAnimationFrame((ts) => this.animLoop(ts));
      }
    }

    animLoop() {
      this.renderVisuals();
      const isRunning = this.pacer && this.pacer.isRunning;
      if (this.antRunning || this.isSimulatingAnt || isRunning) {
        this.animFrameId = requestAnimationFrame(() => this.animLoop());
      } else {
        this.animFrameId = null;
      }
    }

    renderVisuals() {
      if (this.dom.antChartsCollapse && this.dom.antChartsCollapse.style.display === 'none') return;
      this.renderSuperimposedCanvas();
      this.renderLightBarCanvas();
      this.renderFftCanvas();
      this.renderSparklines();
    }

    renderSuperimposedCanvas() {
      const ctx = this.syncCtx;
      if (!ctx) return;
      const w = 520, h = 210;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#0c0d12';
      ctx.fillRect(0, 0, w, h);

      const yTop = 32, yMid = 110, yBottom = 188;
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.beginPath();
      ctx.moveTo(35, yTop); ctx.lineTo(w - 20, yTop);
      ctx.moveTo(35, yBottom); ctx.lineTo(w - 20, yBottom);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(0, 229, 255, 0.14)';
      ctx.beginPath();
      ctx.setLineDash([4, 4]);
      ctx.moveTo(35, yMid); ctx.lineTo(w - 20, yMid);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#64748b';
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'left';
      ctx.fillText('INHALE ▲', 10, yTop + 3);
      ctx.fillText('EXHALE ▼', 10, yBottom + 3);

      if (this.currentPhaseDeg <= 25 && (this.antRunning || this.isSimulatingAnt)) {
        ctx.fillStyle = 'rgba(0, 255, 102, 0.12)';
        ctx.strokeStyle = '#00ff66';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(w - 200, 8, 185, 20, 4);
        else ctx.rect(w - 200, 8, 185, 20);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#00ff66';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('● 0° PHASE LOCK (RESONANCE)', w - 108, 22);
      } else if (this.antRunning || this.isSimulatingAnt) {
        ctx.fillStyle = 'rgba(245, 158, 11, 0.12)';
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(w - 175, 8, 160, 20, 4);
        else ctx.rect(w - 175, 8, 160, 20);
        ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#f59e0b';
        ctx.font = 'bold 10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`HRV PACING • ${this.currentPhaseLagMs} ms LAG`, w - 95, 22);
      }

      const N = this.syncWaveformBuffer.length;
      const xStart = 55, plotW = w - 80;

      if (N < 2) {
        ctx.fillStyle = '#334155';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Waiting for ANT+ HRM signal or simulation...', w / 2, yMid + 4);
        return;
      }

      ctx.save();
      ctx.beginPath();
      const stepX = plotW / (this.SYNC_HISTORY_LEN - 1);

      for (let i = 0; i < N; i++) {
        const px = xStart + (this.SYNC_HISTORY_LEN - N + i) * stepX;
        const py = yMid - this.syncWaveformBuffer[i].resp * (yMid - yTop);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }

      const lastPx = xStart + (this.SYNC_HISTORY_LEN - 1) * stepX;
      const firstPx = xStart + (this.SYNC_HISTORY_LEN - N) * stepX;
      ctx.lineTo(lastPx, yBottom);
      ctx.lineTo(firstPx, yBottom);
      ctx.closePath();

      const cyanGrad = ctx.createLinearGradient(0, yTop, 0, yBottom);
      cyanGrad.addColorStop(0, 'rgba(0, 229, 255, 0.18)');
      cyanGrad.addColorStop(1, 'rgba(0, 229, 255, 0.00)');
      ctx.fillStyle = cyanGrad;
      ctx.fill();

      ctx.beginPath();
      for (let i = 0; i < N; i++) {
        const px = xStart + (this.SYNC_HISTORY_LEN - N + i) * stepX;
        const py = yMid - this.syncWaveformBuffer[i].resp * (yMid - yTop);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.restore();

      let minHR = Infinity, maxHR = -Infinity;
      for (let i = 0; i < N; i++) {
        const hVal = this.syncWaveformBuffer[i].hr;
        if (hVal > 0) {
          if (hVal < minHR) minHR = hVal;
          if (hVal > maxHR) maxHR = hVal;
        }
      }
      if (!isFinite(minHR) || minHR === maxHR) {
        minHR = this.currentHR > 0 ? this.currentHR - 10 : 60;
        maxHR = this.currentHR > 0 ? this.currentHR + 10 : 90;
      }
      minHR -= 1.5; maxHR += 1.5;
      const hrRange = Math.max(4.0, maxHR - minHR);

      ctx.save();
      ctx.strokeStyle = '#ff3366';
      ctx.lineWidth = 2.5;
      ctx.beginPath();

      const heartBeatPoints = [];
      for (let i = 0; i < N; i++) {
        const pt = this.syncWaveformBuffer[i];
        const px = xStart + (this.SYNC_HISTORY_LEN - N + i) * stepX;
        const normHR = (pt.hr - minHR) / hrRange;
        const py = yBottom - Math.max(0.05, Math.min(0.95, normHR)) * (yBottom - yTop);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
        if (pt.isBeat) heartBeatPoints.push({ x: px, y: py });
      }
      ctx.stroke();
      ctx.restore();

      for (let i = 0; i < heartBeatPoints.length; i++) {
        const b = heartBeatPoints[i];
        ctx.beginPath();
        ctx.arc(b.x, b.y, 3.5, 0, 2 * Math.PI);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = '#ff3366';
        ctx.lineWidth = 1.8;
        ctx.stroke();
      }

      const currentHeadX = xStart + (this.SYNC_HISTORY_LEN - 1) * stepX;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(currentHeadX, yTop);
      ctx.lineTo(currentHeadX, yBottom);
      ctx.stroke();

      if (this.currentHR > 0) {
        ctx.fillStyle = '#ff3366';
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'right';
        ctx.fillText(`HR: ${this.currentHR} BPM | RR: ${this.currentRR.toFixed(0)} ms`, currentHeadX - 8, yBottom - 6);
      }
    }

    renderLightBarCanvas() {
      const ctx = this.lightBarCtx;
      if (!ctx) return;
      const w = 160, h = 210;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#05080f';
      ctx.fillRect(0, 0, w, h);

      this.lightBarAnimExcursion += (this.latestBreathExcursion - this.lightBarAnimExcursion) * 0.12;
      if (this.lightBarPeakHoldDecay > 0) this.lightBarPeakHoldDecay--;
      else if (this.lightBarPeakHoldVal > 0) this.lightBarPeakHoldVal = Math.max(0, this.lightBarPeakHoldVal - 0.4);

      const NUM_LEDS = 24, padX = 14, padY = 16, barW = 38;
      const barH = h - padY * 2;
      const ledH = (barH - (NUM_LEDS - 1) * 3) / NUM_LEDS;

      ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(padX - 3, padY - 3, barW + 6, barH + 6, 6);
      else ctx.rect(padX - 3, padY - 3, barW + 6, barH + 6);
      ctx.fill(); ctx.stroke();

      const currentExcursionNorm = Math.max(0, Math.min(1.2, this.lightBarAnimExcursion / 100.0));
      const activeLeds = Math.round((currentExcursionNorm / 1.2) * NUM_LEDS);
      const goalLedIndex = Math.round((1.0 / 1.2) * NUM_LEDS);
      const baseLedIndex = Math.round((0.5 / 1.2) * NUM_LEDS);

      for (let i = 0; i < NUM_LEDS; i++) {
        const ledY = (h - padY) - (i + 1) * (ledH + 3) + 3;
        const isLit = i < activeLeds;

        let fillColor, glowColor;
        if (i >= goalLedIndex) {
          fillColor = isLit ? '#00ff66' : 'rgba(0, 255, 102, 0.08)';
          glowColor = '#00ff66';
        } else if (i >= baseLedIndex) {
          fillColor = isLit ? '#00f0ff' : 'rgba(0, 240, 255, 0.08)';
          glowColor = '#00f0ff';
        } else {
          fillColor = isLit ? '#00b4d8' : 'rgba(0, 180, 216, 0.08)';
          glowColor = '#00b4d8';
        }

        ctx.save();
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(padX, ledY, barW, ledH, 2);
        else ctx.rect(padX, ledY, barW, ledH);
        ctx.fillStyle = fillColor;
        if (isLit) {
          ctx.shadowColor = glowColor;
          ctx.shadowBlur = i >= goalLedIndex ? 8 : 4;
        }
        ctx.fill();
        ctx.restore();
      }

      if (this.lightBarPeakHoldVal > 0) {
        const peakNorm = Math.max(0, Math.min(1.2, this.lightBarPeakHoldVal / 100.0));
        const peakY = (h - padY) - (peakNorm / 1.2) * barH;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(padX - 2, peakY); ctx.lineTo(padX + barW + 2, peakY);
        ctx.stroke();
      }

      const labelX = padX + barW + 10;
      const goalY = (h - padY) - (1.0 / 1.2) * barH;
      ctx.strokeStyle = '#00ff66';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.moveTo(padX + barW + 2, goalY); ctx.lineTo(w - 12, goalY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#00ff66';
      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'left';
      ctx.fillText('GOAL: 2×', labelX, goalY - 4);
      ctx.fillStyle = 'rgba(0, 255, 102, 0.7)';
      ctx.font = '8px monospace';
      ctx.fillText(`${(this.baselineRsaBpm * 2).toFixed(0)} BPM`, labelX, goalY + 8);

      const base1xY = (h - padY) - (0.5 / 1.2) * barH;
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.moveTo(padX + barW + 2, base1xY); ctx.lineTo(w - 12, base1xY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#00e5ff';
      ctx.font = 'bold 9px monospace';
      ctx.fillText('1× BASE', labelX, base1xY - 4);
      ctx.fillStyle = 'rgba(0, 229, 255, 0.7)';
      ctx.font = '8px monospace';
      ctx.fillText(`${this.baselineRsaBpm.toFixed(0)} BPM`, labelX, base1xY + 8);
    }

    renderFftCanvas() {
      const ctx = this.fftCtx;
      if (!ctx) return;
      const w = 700, h = 175;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#080a12';
      ctx.fillRect(0, 0, w, h);

      const padLeft = 45, padRight = 20, padTop = 24, padBottom = 26;
      const plotW = w - padLeft - padRight, plotH = h - padTop - padBottom;
      const fMin = 0.005, fMax = 0.400;

      function freqToX(freq) {
        return padLeft + ((freq - fMin) / (fMax - fMin)) * plotW;
      }

      const xVlfEnd = freqToX(0.04);
      const xLfEnd = freqToX(0.15);

      ctx.fillStyle = 'rgba(124, 58, 237, 0.07)';
      ctx.fillRect(padLeft, padTop, xVlfEnd - padLeft, plotH);
      ctx.fillStyle = 'rgba(0, 229, 255, 0.09)';
      ctx.fillRect(xVlfEnd, padTop, xLfEnd - xVlfEnd, plotH);
      ctx.fillStyle = 'rgba(59, 130, 246, 0.05)';
      ctx.fillRect(xLfEnd, padTop, (padLeft + plotW) - xLfEnd, plotH);

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(xVlfEnd, padTop); ctx.lineTo(xVlfEnd, padTop + plotH);
      ctx.moveTo(xLfEnd, padTop); ctx.lineTo(xLfEnd, padTop + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(167, 139, 250, 0.6)';
      ctx.fillText('VLF (<0.04)', (padLeft + xVlfEnd) / 2, padTop + 14);
      ctx.fillStyle = '#00e5ff';
      ctx.fillText('★ LF RESONANCE ZONE (0.04–0.15 Hz)', (xVlfEnd + xLfEnd) / 2, padTop + 14);
      ctx.fillStyle = 'rgba(96, 165, 250, 0.6)';
      ctx.fillText('HF (0.15–0.40)', (xLfEnd + padLeft + plotW) / 2, padTop + 14);

      const targetBpm = (this.pacer && this.pacer.engine) ? this.pacer.engine.targetBpm : 5.65;
      const targetHz = targetBpm / 60.0;
      const targetX = freqToX(targetHz);

      ctx.strokeStyle = '#ffd600';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(targetX, padTop); ctx.lineTo(targetX, padTop + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#ffd600';
      ctx.font = 'bold 8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`TARGET: ${targetHz.toFixed(3)} Hz`, targetX, padTop + plotH - 6);

      if (this.fftSpectrumBins && this.fftSpectrumBins.length >= 2) {
        const maxPwrScale = Math.max(12.0, this.peakSpectralPower * 1.18);
        ctx.save();
        ctx.beginPath();
        const numPoints = this.fftSpectrumBins.length;
        for (let i = 0; i < numPoints; i++) {
          const pt = this.fftSpectrumBins[i];
          const px = freqToX(pt.freq);
          const normPwr = Math.max(0, pt.pwr / maxPwrScale);
          const py = (padTop + plotH) - normPwr * plotH;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }

        const lastX = freqToX(this.fftSpectrumBins[numPoints - 1].freq);
        const firstX = freqToX(this.fftSpectrumBins[0].freq);
        ctx.lineTo(lastX, padTop + plotH);
        ctx.lineTo(firstX, padTop + plotH);
        ctx.closePath();

        const grad = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
        grad.addColorStop(0, 'rgba(0, 229, 255, 0.28)');
        grad.addColorStop(1, 'rgba(0, 229, 255, 0.00)');
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.beginPath();
        for (let i = 0; i < numPoints; i++) {
          const pt = this.fftSpectrumBins[i];
          const px = freqToX(pt.freq);
          const normPwr = Math.max(0, pt.pwr / maxPwrScale);
          const py = (padTop + plotH) - normPwr * plotH;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.strokeStyle = '#00e5ff';
        ctx.lineWidth = 2.2;
        ctx.stroke();
        ctx.restore();

        if (this.peakSpectralPower > 0 && this.peakSpectralFreq > 0) {
          const peakX = freqToX(this.peakSpectralFreq);
          const peakNorm = Math.max(0, this.peakSpectralPower / maxPwrScale);
          const peakY = (padTop + plotH) - peakNorm * plotH;

          ctx.save();
          ctx.beginPath();
          ctx.arc(peakX, peakY, 6, 0, 2 * Math.PI);
          ctx.strokeStyle = '#00ff66';
          ctx.lineWidth = 2;
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(peakX, peakY, 3, 0, 2 * Math.PI);
          ctx.fillStyle = '#ffffff';
          ctx.fill();

          ctx.fillStyle = '#00ff66';
          ctx.font = 'bold 9px monospace';
          ctx.textAlign = 'center';
          const labelY = Math.max(padTop + 10, peakY - 10);
          ctx.fillText(`▲ ${this.peakSpectralFreq.toFixed(3)} Hz`, peakX, labelY);
          ctx.restore();
        }
      }

      ctx.fillStyle = '#64748b';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      const tickFreqs = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40];
      for (let i = 0; i < tickFreqs.length; i++) {
        const tf = tickFreqs[i];
        const tx = freqToX(tf);
        ctx.fillText(`${tf.toFixed(2)}`, tx, h - 8);
      }
    }

    renderSparklines() {
      const hrLabel = this.currentHR > 0 ? `${this.currentHR} BPM` : '-- BPM';
      const rrLabel = this.currentRR > 0 ? `${this.currentRR.toFixed(1)} ms` : '-- ms';
      const rmssdLabel = this.currentRMSSD > 0 ? `${this.currentRMSSD.toFixed(1)} ms` : '-- ms';
      this.drawSparkline(this.sparkHrCtx, this.dom.sparkHrCanvas, this.hrHistory, 40, 160, '#ff3366', hrLabel);
      this.drawSparkline(this.sparkRrCtx, this.dom.sparkRrCanvas, this.rrHistory, 300, 1500, '#00e5ff', rrLabel);
      this.drawSparkline(this.sparkRmssdCtx, this.dom.sparkRmssdCanvas, this.rmssdHistory, 0, 120, '#00ff66', rmssdLabel);
    }

    drawSparkline(ctx, canvas, data, vMin, vMax, color, labelText) {
      if (!ctx || !canvas) return;
      const w = 220, h = 75;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#0f1118';
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(8, h / 2); ctx.lineTo(w - 8, h / 2);
      ctx.stroke();

      if (data.length > 0 && labelText) {
        ctx.fillStyle = color;
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'right';
        ctx.fillText(labelText, w - 8, 14);
      }
      if (data.length < 2) return;

      const padX = 8, padY = 16;
      const plotW = w - padX * 2, plotH = h - padY * 2;
      const stepX = plotW / (this.HISTORY_LEN - 1);
      const startOffset = this.HISTORY_LEN - data.length;

      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      for (let i = 0; i < data.length; i++) {
        const val = data[i];
        const norm = Math.max(0, Math.min(1, (val - vMin) / (vMax - vMin)));
        const px = padX + (startOffset + i) * stepX;
        const py = (h - padY) - norm * plotH;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.restore();
    }

    exportJsonl() {
      if (this.sessionLogs.length === 0) {
        alert('Keine Messdaten vorhanden. Bitte zuerst ANT+ verbinden oder Simulation starten!\nNo session data recorded yet.');
        return;
      }
      const lines = this.sessionLogs.map((entry) => JSON.stringify(entry));
      const blob = new Blob([lines.join('\n')], { type: 'application/jsonlines;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `peakfrequency_ant_session_${Math.floor(Date.now() / 1000)}.jsonl`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  }

  return {
    AntBiometricsController: AntBiometricsController,
    AntHrmDriver: AntHrmDriver
  };
});
