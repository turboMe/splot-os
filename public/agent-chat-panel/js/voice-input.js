/**
 * Splot OS — Voice Input Controller (Google Gemini Speech-to-Text)
 * Enables voice recording in chat composers, transcribes Polish and English speech
 * via Google Gemini multimodal models, and inserts transcribed text directly into the textarea
 * for user verification before manual submission.
 */

export class VoiceInputController {
  /**
   * @param {Object} options
   * @param {HTMLButtonElement} options.triggerBtn - Microphone button element
   * @param {HTMLTextAreaElement} options.textarea - Target textarea to receive transcribed text
   * @param {HTMLElement} [options.composerBox] - Container element to host the live recording banner
   * @param {Function} [options.onToast] - Optional callback for user notifications
   * @param {Function} [options.onResize] - Optional callback to trigger textarea auto-resize
   */
  constructor({ triggerBtn, textarea, composerBox, onToast, onResize }) {
    this.triggerBtn = triggerBtn;
    this.textarea = textarea;
    this.composerBox = composerBox || textarea?.closest('.composer') || textarea?.parentElement;
    this.onToast = onToast || ((msg) => console.log('[VoiceInput]', msg));
    this.onResize = onResize || (() => {});

    this.mediaRecorder = null;
    this.audioStream = null;
    this.audioChunks = [];
    this.isRecording = false;
    this.isTranscribing = false;
    this.recordStartTime = 0;
    this.timerInterval = null;
    this.maxDurationSec = 180; // 3 minutes safety limit

    this.statusBarEl = null;

    this.init();
  }

  init() {
    if (!this.triggerBtn || !this.textarea) return;

    this.triggerBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.isRecording) {
        this.stopAndTranscribe();
      } else if (!this.isTranscribing) {
        this.startRecording();
      }
    });
  }

  /**
   * Selects best supported audio MIME type in browser
   */
  getSupportedMimeType() {
    if (typeof MediaRecorder === 'undefined') return 'audio/webm';
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/ogg',
      'audio/mp4',
      'audio/aac',
      'audio/wav',
    ];
    for (const t of types) {
      if (MediaRecorder.isTypeSupported(t)) {
        return t;
      }
    }
    return '';
  }

  /**
   * Starts microphone recording
   */
  async startRecording() {
    if (this.isRecording || this.isTranscribing) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      this.onToast('Twoja przeglądarka nie udostępnia API mikrofonu (getUserMedia).', 'error');
      return;
    }

    try {
      this.audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      console.error('[VoiceInput] Mic access denied:', err);
      let errMsg = 'Brak dostępu do mikrofonu. Zezwól na dostęp w ustawieniach przeglądarki.';
      if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        errMsg = 'Nie znaleziono mikrofonu w Twoim urządzeniu.';
      }
      this.onToast(errMsg, 'error');
      return;
    }

    this.audioChunks = [];
    const mimeType = this.getSupportedMimeType();
    const options = mimeType ? { mimeType } : {};

    try {
      this.mediaRecorder = new MediaRecorder(this.audioStream, options);
    } catch (err) {
      console.warn('[VoiceInput] MediaRecorder fallback:', err);
      this.mediaRecorder = new MediaRecorder(this.audioStream);
    }

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this.audioChunks.push(event.data);
      }
    };

    this.mediaRecorder.onstop = () => {
      // Clean audio tracks
      this.cleanupStream();
    };

    this.mediaRecorder.onerror = (event) => {
      console.error('[VoiceInput] MediaRecorder error:', event);
      this.cancelRecording();
      this.onToast('Wystąpił błąd podczas nagrywania dźwięku.', 'error');
    };

    this.mediaRecorder.start(250); // Collect data chunks every 250ms
    this.isRecording = true;
    this.recordStartTime = Date.now();

    // Global escape key handler to cancel recording
    this.escapeHandler = (e) => {
      if (e.key === 'Escape' && this.isRecording) {
        e.preventDefault();
        this.cancelRecording();
      }
    };
    document.addEventListener('keydown', this.escapeHandler, { once: true });

    this.updateUIState('recording');
    this.startTimer();
    this.onToast('🎙️ Słucham... Mów po polsku lub angielsku (Esc aby anulować)');
  }

  /**
   * Stops recording and initiates Google Gemini transcription
   */
  async stopAndTranscribe() {
    if (!this.isRecording || !this.mediaRecorder) return;

    this.removeEscapeHandler();
    this.stopTimer();
    this.isRecording = false;
    this.isTranscribing = true;
    this.updateUIState('transcribing');

    // Return a promise that resolves when mediaRecorder fires onstop (with safety timeout)
    const recordStopped = new Promise((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        resolve();
        return;
      }
      const origOnStop = this.mediaRecorder.onstop;
      this.mediaRecorder.onstop = (e) => {
        if (origOnStop) origOnStop.call(this.mediaRecorder, e);
        resolve();
      };
      setTimeout(resolve, 1200);
    });

    try {
      if (this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.stop();
      }
    } catch (err) {
      console.warn('[VoiceInput] Error stopping mediaRecorder:', err);
    }

    await recordStopped;

    if (this.audioChunks.length === 0) {
      this.finishTranscription(null, 'Nie zarejestrowano dźwięku.');
      return;
    }

    const finalMime = this.mediaRecorder?.mimeType || this.getSupportedMimeType() || 'audio/webm';
    const audioBlob = new Blob(this.audioChunks, { type: finalMime });

    if (audioBlob.size < 100) {
      this.finishTranscription(null, 'Nagranie było zbyt krótkie.');
      return;
    }

    try {
      const base64Data = await this.blobToBase64(audioBlob);
      const res = await fetch('/splot/api/voice/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioBase64: base64Data,
          mimeType: finalMime,
        }),
      });

      const json = await res.json().catch(() => null);

      if (!res.ok || !json?.success) {
        const errorMsg = json?.error || `Błąd serwera (${res.status})`;
        throw new Error(errorMsg);
      }

      const transcribedText = (json.text || '').trim();
      this.finishTranscription(transcribedText);
    } catch (err) {
      console.error('[VoiceInput] Transcription failed:', err);
      this.finishTranscription(null, err.message);
    }
  }

  removeEscapeHandler() {
    if (this.escapeHandler) {
      document.removeEventListener('keydown', this.escapeHandler);
      this.escapeHandler = null;
    }
  }

  /**
   * Cancels ongoing recording and discards audio
   */
  cancelRecording() {
    this.removeEscapeHandler();
    this.stopTimer();
    this.isRecording = false;
    this.isTranscribing = false;

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try {
        this.mediaRecorder.stop();
      } catch {}
    }
    this.cleanupStream();
    this.audioChunks = [];
    this.updateUIState('idle');
    this.onToast('Nagrywanie anulowane.');
  }

  /**
   * Handles finished transcription text insertion into textarea
   */
  finishTranscription(text, errorMessage = null) {
    this.isRecording = false;
    this.isTranscribing = false;
    this.updateUIState('idle');
    this.cleanupStream();

    if (errorMessage) {
      this.onToast(`Błąd transkrypcji: ${errorMessage}`, 'error');
      return;
    }

    if (!text) {
      this.onToast('ℹ️ Nie wykryto mowy w nagraniu.');
      return;
    }

    // Insert transcribed text into textarea
    const currentVal = this.textarea.value;
    if (!currentVal.trim()) {
      this.textarea.value = text;
    } else {
      // Append text with space or newline
      const needsSpace = !currentVal.endsWith(' ') && !currentVal.endsWith('\n');
      this.textarea.value = currentVal + (needsSpace ? ' ' : '') + text;
    }

    // Trigger input event for autoResize and drafts
    this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
    if (this.onResize) this.onResize();

    // Focus textarea and place cursor at the end
    this.textarea.focus();
    const len = this.textarea.value.length;
    this.textarea.setSelectionRange(len, len);

    this.onToast(`✨ Rozpoznano mowę (${text.length} znaków) — sprawdź i wyślij`);
  }

  cleanupStream() {
    if (this.audioStream) {
      for (const track of this.audioStream.getTracks()) {
        try {
          track.stop();
        } catch {}
      }
      this.audioStream = null;
    }
  }

  blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const res = reader.result;
        if (typeof res === 'string') {
          resolve(res);
        } else {
          reject(new Error('Nie udało się przekonwertować pliku audio do Base64'));
        }
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  startTimer() {
    this.stopTimer();
    this.timerInterval = setInterval(() => {
      if (!this.isRecording) {
        this.stopTimer();
        return;
      }
      const elapsedSec = Math.floor((Date.now() - this.recordStartTime) / 1000);
      if (elapsedSec >= this.maxDurationSec) {
        this.stopAndTranscribe();
        return;
      }
      this.updateTimerDisplay(elapsedSec);
    }, 500);
  }

  stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  updateTimerDisplay(elapsedSec) {
    const timerEl = this.statusBarEl?.querySelector('.voice-timer');
    if (timerEl) {
      timerEl.textContent = this.formatTime(elapsedSec);
    }
  }

  /**
   * Updates UI according to state: 'idle' | 'recording' | 'transcribing'
   */
  updateUIState(state) {
    // 1. Button classes & title
    if (state === 'recording') {
      this.triggerBtn.classList.add('is-recording');
      this.triggerBtn.classList.remove('is-transcribing');
      this.triggerBtn.title = 'Zakończ słuchać i zamień na tekst (Google Gemini)';
      this.triggerBtn.innerHTML = '⏹';
    } else if (state === 'transcribing') {
      this.triggerBtn.classList.remove('is-recording');
      this.triggerBtn.classList.add('is-transcribing');
      this.triggerBtn.title = 'Przetwarzanie nagrania przez Google Gemini...';
      this.triggerBtn.innerHTML = '<span class="voice-spinner"></span>';
    } else {
      this.triggerBtn.classList.remove('is-recording', 'is-transcribing');
      this.triggerBtn.title = 'Mów zamiast pisać (Google Gemini Speech-to-Text)';
      this.triggerBtn.innerHTML = '🎙️';
    }

    // 2. Status Banner creation / removal
    if (state === 'idle') {
      if (this.statusBarEl) {
        this.statusBarEl.remove();
        this.statusBarEl = null;
      }
      return;
    }

    if (!this.statusBarEl) {
      this.statusBarEl = document.createElement('div');
      this.statusBarEl.className = 'voice-status-bar';
      if (this.composerBox) {
        const modalBody = this.composerBox.querySelector('.modal-body');
        const attachRow = this.composerBox.querySelector('.attach-row');
        const composerInner = this.composerBox.querySelector('.composer-box');
        if (modalBody) {
          modalBody.insertBefore(this.statusBarEl, modalBody.firstChild);
        } else if (attachRow && attachRow.nextSibling) {
          this.composerBox.insertBefore(this.statusBarEl, attachRow.nextSibling);
        } else if (composerInner) {
          this.composerBox.insertBefore(this.statusBarEl, composerInner);
        } else {
          this.composerBox.insertBefore(this.statusBarEl, this.composerBox.firstChild);
        }
      }
    }

    if (state === 'recording') {
      this.statusBarEl.innerHTML = `
        <div class="voice-status-left">
          <span class="voice-pulse-dot"></span>
          <span class="voice-status-text">Słucham... (PL/EN)</span>
          <span class="voice-timer">00:00</span>
        </div>
        <div class="voice-status-actions">
          <button type="button" class="btn-voice-stop" id="btn-voice-stop-${Date.now()}">⏹ Zakończ słuchać</button>
          <button type="button" class="btn-voice-cancel" id="btn-voice-cancel-${Date.now()}" title="Anuluj nagranie">✕ Anuluj</button>
        </div>
      `;

      const stopBtn = this.statusBarEl.querySelector('.btn-voice-stop');
      const cancelBtn = this.statusBarEl.querySelector('.btn-voice-cancel');

      stopBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.stopAndTranscribe();
      });

      cancelBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.cancelRecording();
      });
    } else if (state === 'transcribing') {
      this.statusBarEl.innerHTML = `
        <div class="voice-status-left">
          <span class="voice-spinner"></span>
          <span class="voice-status-text">Google Gemini transkrybuje mowę...</span>
        </div>
        <div class="voice-status-actions">
          <span style="font-size:10.5px;color:var(--muted);font-family:var(--font-mono);">gemini-2.5-flash</span>
        </div>
      `;
    }
  }
}
