/* ===========================================================================
   COSMO SELECT — visual skin-screening prototype (frontend module)

   Experimental browser-assisted cosmetic screening: the browser captures or
   accepts an image, a local Python/Flask API (MediaPipe + OpenCV) measures
   visible-feature signals, and the user confirms suggested concerns which
   are then applied through the EXISTING selector. Product retrieval still
   runs through the untouched buildQuery()/findProducts() in app.js.

   No analysis is simulated: if the API is unreachable the user is told so.
   =========================================================================== */
(() => {
  'use strict';

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------
  const SKIN_ANALYSIS_API =
    window.COSMO_SKIN_API_URL || 'http://127.0.0.1:5000/api/analyse-skin';
  const REQUEST_TIMEOUT_MS = 12000;
  const MAX_FILE_BYTES = 8 * 1024 * 1024;
  const MIN_IMAGE_SIDE = 480;
  const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  const COUNTDOWN_SECONDS = 3;
  // Live face tracking is done by the API, not the browser.
  const FACE_POSITION_API =
    (window.COSMO_SKIN_API_URL || 'http://127.0.0.1:5000/api/analyse-skin')
      .replace('/analyse-skin', '/face-position');
  const TRACK_INTERVAL_MS = 360;   // ~3 checks a second
  const TRACK_FRAME_WIDTH = 320;   // small frames keep tracking cheap
  const YAW_FRONT_MAX = 0.30;      // counts as facing the camera
  const YAW_TURNED_MIN = 0.45;     // counts as a deliberate turn

  // Guided multi-angle capture. A single front-on frame foreshortens the
  // outer cheeks and hides skin near the jaw, so the user is walked through
  // three poses and every usable frame is measured.
  const CAPTURE_ANGLES = [
    { id: 'front', title: 'Look straight ahead', arrow: '', done: 'Front view saved' },
    { id: 'left', title: 'Turn your head to the left', arrow: '←', done: 'Left side saved' },
    { id: 'right', title: 'Turn your head to the right', arrow: '→', done: 'Right side saved' }
  ];
  // A local API answers in well under a second, which makes the scan flash by
  // before the user can read what is happening. Hold the scanning view for at
  // least this long so the stages are legible. This is presentation only: the
  // real request is already complete and no stage is faked.
  const MIN_SCAN_MS = 3200;
  const HOLD_STABLE_MS = 600;      // face must stay aligned this long first
  // Analysis canvas. Contain-fitting a portrait onto a 4:3 canvas letterboxes
  // it, so the face occupies only part of the width; at 1024 wide that left
  // the face around 400 px and the server then had to UPSCALE it to the
  // canonical 480 px, blurring exactly the small colour clusters the redness
  // detector looks for. A larger canvas keeps the face above canonical size
  // so it is only ever downsampled.
  const OUTPUT_W = 1440;
  const OUTPUT_H = 1080;
  // Longest side of an unframed analysis image. Large enough that a face is
  // comfortably above the server's canonical measuring size, so it is only
  // ever downsampled; small enough to keep uploads quick.
  const MAX_ANALYSIS_DIM = 1600;
  // High enough that JPEG artefacts do not blur the small local colour
  // differences the redness and blemish detectors measure.
  const ANALYSIS_JPEG_QUALITY = 0.96;

  const SCAN_STATES = {
    IDLE: 'idle',
    CAMERA: 'camera',
    IMAGE_SELECTED: 'image-selected',
    CAPTURED: 'captured',
    SCANNING: 'scanning',
    RESULT: 'result',
    ERROR: 'error'
  };

  const SIGNAL_LABELS = {
    redness: 'Redness-like colour signal',
    acne: 'Blemish-like spot signal',
    dryness: 'Flake-like texture signal',
    dehydration: 'Fine-line texture signal'
  };
  // Calibrated bands returned by the API. Wording stays cautious: these
  // describe a visible-feature measurement, never a diagnosis.
  const LEVEL_TEXT = {
    low: 'No meaningful signal',
    mild: 'Mild visible signal',
    moderate: 'Moderate visible signal',
    high: 'Strong visible signal',
    uncertain: 'Uncertain in this photo',
    // Dehydration is measured but never converted into a concern: a single
    // photograph cannot separate it from fine lines, shine or image contrast.
    not_assessable: 'Not assessable from a photo'
  };
  const LEVEL_STEPS = {
    low: 1, mild: 1, moderate: 2, high: 3, uncertain: 0, not_assessable: 0
  };

  // -------------------------------------------------------------------------
  // Elements (all defensively resolved once)
  // -------------------------------------------------------------------------
  const $ = id => document.getElementById(id);
  const el = {
    openBtn: $('scanOpenBtn'),
    overlay: $('scanOverlay'),
    modal: $('scanModal'),
    body: $('scanBody'),
    bodyWrap: $('scanBodyWrap'),
    closeBtn: $('scanCloseBtn'),
    cameraBtn: $('scanCameraBtn'),
    uploadBtn: $('scanUploadBtn'),
    fileInput: $('scanFileInput'),
    cameraVideo: $('scanCameraVideo'),
    freezeCanvas: $('scanFreezeCanvas'),
    guide: $('scanGuide'),
    guideProgress: $('scanGuideProgress'),
    countdown: $('scanCountdown'),
    flash: $('scanFlash'),
    cameraHint: $('scanCameraHint'),
    captureProgress: $('scanCaptureProgress'),
    poseCount: $('scanPoseCount'),
    poseText: $('scanPoseText'),
    cameraStage: $('scanCameraStage'),
    imageStage: $('scanImageStage'),
    imagePreview: $('scanImagePreview'),
    zoom: $('scanZoom'),
    progressImage: $('scanProgressImage'),
    stageText: $('scanStageText'),
    results: $('scanResults'),
    errorBox: $('scanErrorBox'),
    qualityBanner: $('scanQualityBanner'),
    qualityText: $('scanQualityText'),
    qualityRetakeBtn: $('scanQualityRetakeBtn'),
    footer: $('scanFooter'),
    captureBtn: $('scanCaptureBtn'),
    analyseBtn: $('scanAnalyseBtn'),
    useBtn: $('scanUseBtn'),
    retryBtn: $('scanRetryBtn'),
    retakeBtn: $('scanRetakeBtn'),
    replaceBtn: $('scanReplaceBtn'),
    resetPosBtn: $('scanResetPosBtn'),
    switchUploadBtn: $('scanSwitchUploadBtn'),
    cancelBtn: $('scanCancelBtn')
  };
  if (Object.values(el).some(node => !node)) {
    console.warn('Skin scan: required elements missing; module disabled.');
    return;
  }

  // -------------------------------------------------------------------------
  // State (single source of truth)
  // -------------------------------------------------------------------------
  let scanState = SCAN_STATES.IDLE;
  let cameraStream = null;
  let trackTimer = null;
  let trackController = null;
  let trackCanvas = null;
  let trackingBusy = false;
  let firstTurnSign = 0;      // direction of the first turn the sitter made
  let lastCaptureYaw = 0;
  let alignedSince = 0;
  let countdownTimer = null;
  let countdownValue = 0;
  let capturedBlobs = [];        // camera captures, already mirrored
  let captureStep = 0;           // index into CAPTURE_ANGLES
  let uploadedFile = null;
  let previewUrl = null;
  let requestController = null;
  let stageTimer = null;
  let lastSuggestions = [];
  let lastFocused = null;
  let lastQuality = null;          // capture-quality block from the API
  let lastAlgorithmVersion = null;
  let imageSource = null;          // 'camera' | 'upload'

  // Uploaded-image transform state.
  let imageScale = 1;
  let imageOffsetX = 0;
  let imageOffsetY = 0;
  let dragging = false;
  let dragStartX = 0;
  let dragStartY = 0;

  // -------------------------------------------------------------------------
  // Local feedback log (for later controlled evaluation)
  //
  // PRIVACY: this stores ONLY non-identifying diagnostic fields, in this
  // browser's localStorage, and nothing is transmitted anywhere. No face
  // image, no identity, no demographic data and no skin-tone classification
  // is recorded. Estimating a user's skin tone without explicit consent would
  // itself be a privacy and fairness problem, so it is deliberately not done.
  // -------------------------------------------------------------------------
  const FEEDBACK_KEY = 'cosmo-scan-feedback-v1';

  function readFeedback() {
    try {
      const raw = localStorage.getItem(FEEDBACK_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function recordFeedback(entry) {
    try {
      const log = readFeedback();
      log.push(entry);
      localStorage.setItem(FEEDBACK_KEY, JSON.stringify(log));
    } catch (error) {
      // Private browsing or a full quota; feedback is optional, so carry on.
      console.warn('Feedback could not be stored locally.', error);
    }
  }



  // -------------------------------------------------------------------------
  // State controller — one function decides what is visible.
  // -------------------------------------------------------------------------
  const views = [...el.body.querySelectorAll('.scan-view')];
  const showView = name => views.forEach(v => { v.hidden = v.dataset.view !== name; });
  const show = (...buttons) => {
    [el.captureBtn, el.analyseBtn, el.useBtn, el.retryBtn, el.retakeBtn,
     el.replaceBtn, el.resetPosBtn, el.switchUploadBtn, el.cancelBtn]
      .forEach(b => { b.hidden = !buttons.includes(b); });
  };

  // Shows the bottom fade only while there is more content to reach, so a
  // card clipped by the scroll edge reads as "scroll for more", not "broken".
  function updateScrollAffordance() {
    const { scrollTop, scrollHeight, clientHeight } = el.body;
    const more = scrollHeight - clientHeight - scrollTop > 8;
    el.bodyWrap.classList.toggle('has-more', more);
  }
  el.body.addEventListener('scroll', updateScrollAffordance, { passive: true });
  window.addEventListener('resize', updateScrollAffordance);

  function setScanState(nextState) {
    scanState = nextState;
    // Views change height, so re-check after the new content is laid out.
    requestAnimationFrame(updateScrollAffordance);
    switch (nextState) {
      case SCAN_STATES.IDLE:
        showView('idle');
        show(el.cancelBtn);
        break;
      case SCAN_STATES.CAMERA:
        showView('camera');
        show(el.captureBtn, el.switchUploadBtn, el.cancelBtn);
        break;
      case SCAN_STATES.IMAGE_SELECTED:
        showView('image');
        show(el.analyseBtn, el.replaceBtn, el.resetPosBtn, el.cancelBtn);
        break;
      case SCAN_STATES.CAPTURED:
        showView('camera'); // frozen frame remains visible
        show(el.cancelBtn);
        break;
      case SCAN_STATES.SCANNING:
        showView('scanning');
        show(el.cancelBtn);
        break;
      case SCAN_STATES.RESULT:
        showView('result');
        show(el.useBtn, el.retakeBtn, el.cancelBtn);
        el.useBtn.hidden = lastSuggestions.length === 0;
        break;
      case SCAN_STATES.ERROR:
        showView('error');
        show(el.retryBtn, el.replaceBtn, el.cancelBtn);
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Modal open / close, focus and scroll management
  // -------------------------------------------------------------------------
  function openModal() {
    // Fall back to the opening button when the modal is triggered without a
    // meaningful focus origin, so focus is never stranded on a hidden node.
    const origin = document.activeElement;
    lastFocused = (origin && origin !== document.body) ? origin : el.openBtn;
    el.overlay.hidden = false;
    document.body.classList.add('scan-open');
    // Lenis runs its own scroll loop and ignores body overflow, so it has to
    // be paused explicitly or the page scrolls behind the dialog.
    window.cosmoLockScroll?.(true);
    resetAll();
    setScanState(SCAN_STATES.IDLE);
    el.closeBtn.focus();
  }

  function closeModal() {
    stopEverything();
    // Move focus out before hiding, otherwise it stays on a hidden control.
    const target = (lastFocused && typeof lastFocused.focus === 'function')
      ? lastFocused : el.openBtn;
    target.focus();
    el.overlay.hidden = true;
    document.body.classList.remove('scan-open');
    window.cosmoLockScroll?.(false);
  }

  function resetAll() {
    stopEverything();
    capturedBlobs = [];
    captureStep = 0;
    firstTurnSign = 0;
    lastCaptureYaw = 0;
    uploadedFile = null;
    lastSuggestions = [];
    releasePreviewUrl();
    resetImageTransform();
    el.freezeCanvas.hidden = true;
    el.cameraVideo.hidden = false;
    el.results.replaceChildren();
    el.errorBox.replaceChildren();
    el.qualityBanner.hidden = true;
    lastQuality = null;
  }

  function stopEverything() {
    stopCamera();
    stopDetectLoop();
    cancelCountdown();
    if (requestController) { requestController.abort(); requestController = null; }
    if (stageTimer) { clearInterval(stageTimer); stageTimer = null; }
  }

  function releasePreviewUrl() {
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  }

  // -------------------------------------------------------------------------
  // Camera
  // -------------------------------------------------------------------------
  async function openCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      return showError('Camera access is not supported in this browser. Choose an image instead.');
    }
    setScanState(SCAN_STATES.CAMERA);
    captureStep = capturedBlobs.length;
    updateCaptureProgress();
    el.cameraHint.textContent = 'Starting camera…';
    el.freezeCanvas.hidden = true;
    el.cameraVideo.hidden = false;
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      el.cameraVideo.srcObject = cameraStream;
      await el.cameraVideo.play().catch(() => {});
      // If the stream dies unexpectedly, surface a real error.
      cameraStream.getVideoTracks().forEach(track => {
        track.addEventListener('ended', () => {
          if (scanState === SCAN_STATES.CAMERA) {
            showError('The camera stream ended unexpectedly. Try again or choose an image.');
          }
        });
      });
      startFaceGuidance();
    } catch (error) {
      console.error('Camera error', error);
      showError(error?.name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow camera access or choose an image instead.'
        : 'The camera could not be started. Choose an image instead.');
    }
  }

  function stopCamera() {
    if (!cameraStream) return;
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
    el.cameraVideo.srcObject = null;
  }

  document.addEventListener('visibilitychange', () => {
    // Do not leave the webcam running while the tab is hidden.
    if (document.hidden && scanState === SCAN_STATES.CAMERA) {
      stopCamera();
      stopDetectLoop();
      cancelCountdown();
      el.cameraHint.textContent = 'Camera paused. Reopen the camera to continue.';
    }
  });

  // -------------------------------------------------------------------------
  // Live face guidance (browser FaceDetector — alignment only, NOT analysis)
  // -------------------------------------------------------------------------
  function startFaceGuidance() {
    // Server-side tracking. The browser's own FaceDetector API is behind a
    // flag in Chrome and missing elsewhere, so depending on it meant
    // auto-capture silently never ran and every pose needed a button press.
    // Posting small frames to the MediaPipe endpoint works everywhere and
    // additionally reports head turn, which FaceDetector cannot.
    alignedSince = 0;
    trackingBusy = false;
    if (trackTimer) clearInterval(trackTimer);
    trackTimer = setInterval(trackTick, TRACK_INTERVAL_MS);
    el.cameraHint.textContent = 'Line your face up with the oval';
  }

  function stopDetectLoop() {
    if (trackTimer) { clearInterval(trackTimer); trackTimer = null; }
    if (trackController) { trackController.abort(); trackController = null; }
    trackingBusy = false;
    el.guide.classList.remove('aligned');
    setHoldProgress(0);
  }

  // Grabs a small frame and asks the API where the face is.
  async function trackTick() {
    if (scanState !== SCAN_STATES.CAMERA || !cameraStream || trackingBusy) return;
    const video = el.cameraVideo;
    if (!video.videoWidth) return;

    trackingBusy = true;
    try {
      const width = TRACK_FRAME_WIDTH;
      const height = Math.round(width * video.videoHeight / video.videoWidth);
      if (!trackCanvas) trackCanvas = document.createElement('canvas');
      trackCanvas.width = width;
      trackCanvas.height = height;
      // Drawn unmirrored: the yaw sign must refer to the real camera frame.
      trackCanvas.getContext('2d').drawImage(video, 0, 0, width, height);

      const blob = await new Promise(resolve =>
        trackCanvas.toBlob(resolve, 'image/jpeg', 0.7));
      if (!blob) return;

      const formData = new FormData();
      formData.append('frame', blob, 'frame.jpg');
      trackController = new AbortController();
      const response = await fetch(FACE_POSITION_API, {
        method: 'POST', body: formData, signal: trackController.signal
      });
      const data = await response.json();
      if (scanState === SCAN_STATES.CAMERA) evaluatePosition(data);
    } catch (error) {
      if (error.name !== 'AbortError') {
        // A dropped frame is not worth surfacing; the next tick retries.
        console.debug('Face tracking tick failed', error);
      }
    } finally {
      trackingBusy = false;
    }
  }

  function evaluatePosition(data) {
    if (countdownTimer) {
      // The countdown only continues while the pose still holds.
      if (poseProblem(data)) {
        cancelCountdown();
        el.guide.classList.remove('aligned');
        el.cameraHint.textContent = 'Hold that position a moment longer';
      }
      return;
    }
    const problem = poseProblem(data);
    if (problem) {
      hint(problem);
      return;
    }

    el.guide.classList.add('aligned');
    if (!alignedSince) alignedSince = performance.now();
    const held = performance.now() - alignedSince;
    setHoldProgress(Math.min(1, held / HOLD_STABLE_MS));
    el.cameraHint.textContent = 'Perfect. Hold still';
    if (held >= HOLD_STABLE_MS) {
      lastCaptureYaw = data.yaw;
      startCountdown();
    }
  }

  function hint(message) {
    alignedSince = 0;
    el.guide.classList.remove('aligned');
    setHoldProgress(0);
    el.cameraHint.textContent = message;
  }

  // Returns a guidance string while the requested pose is not yet held, or
  // null when everything is right and capture may begin.
  function poseProblem(data) {
    if (!data || !data.found) {
      return data && data.reason === 'multiple_faces'
        ? 'Only one person in frame, please'
        : 'Face not detected. Look toward the camera.';
    }

    const box = data.box;
    const centreX = box.x + box.width / 2;
    const centreY = box.y + box.height / 2;
    const angle = CAPTURE_ANGLES[Math.min(captureStep, CAPTURE_ANGLES.length - 1)];
    const turned = angle.id !== 'front';

    // Framing. Tolerances are generous, and looser still once the head is
    // turned, because a turned face is narrower and sits off centre.
    if (box.width < (turned ? 0.16 : 0.20)) return 'Move a little closer';
    if (box.width > 0.92) return 'Move back slightly';
    if (Math.abs(centreY - 0.48) > 0.22) return 'Centre your face';
    if (!turned && Math.abs(centreX - 0.5) > 0.20) return 'Centre your face';

    // Pose. The sign of a turn is not asserted: whichever way the sitter
    // turns first is accepted, and the final pose simply has to be the other
    // way. That keeps the flow working even if someone turns the "wrong" way.
    const yaw = data.yaw;
    if (!turned) {
      if (Math.abs(yaw) > YAW_FRONT_MAX) return 'Face the camera straight on';
      return null;
    }
    if (Math.abs(yaw) < YAW_TURNED_MIN) {
      return `Turn your head ${angle.arrow === '←' ? 'left' : 'right'} a little more`;
    }
    if (firstTurnSign && Math.sign(yaw) === firstTurnSign) {
      return 'Now turn the other way';
    }
    return null;
  }

  function setHoldProgress(fraction) {
    // Ellipse circumference ≈ 340 in the SVG's own units.
    el.guideProgress.style.strokeDashoffset = String(340 * (1 - fraction));
  }

  // -------------------------------------------------------------------------
  // Countdown and automatic capture
  // -------------------------------------------------------------------------
  function startCountdown() {
    if (countdownTimer) return;
    countdownValue = COUNTDOWN_SECONDS;
    el.countdown.hidden = false;
    el.countdown.textContent = String(countdownValue);
    countdownTimer = setInterval(() => {
      countdownValue -= 1;
      if (countdownValue <= 0) {
        cancelCountdown();
        captureFrame();
        return;
      }
      el.countdown.textContent = String(countdownValue);
    }, 1000);
  }

  function cancelCountdown() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    el.countdown.hidden = true;
    alignedSince = 0;
    setHoldProgress(0);
  }

  function captureFrame() {
    const video = el.cameraVideo;
    if (!video.videoWidth || !video.videoHeight) {
      return showError('The camera image was not ready. Try again.');
    }
    const canvas = el.freezeCanvas;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) return showError('The captured frame could not be processed.');

    // Mirror so the stored frame matches the mirrored preview.
    context.save();
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    context.restore();

    // Flash and freeze the frame. The camera keeps running between poses.
    el.flash.classList.remove('flashing');
    void el.flash.offsetWidth;
    el.flash.classList.add('flashing');
    stopDetectLoop();
    cancelCountdown();

    canvas.toBlob(blob => {
      if (!blob) return showError('The captured frame could not be encoded. Try again.');
      capturedBlobs.push(blob);
      imageSource = 'camera';
      const angle = CAPTURE_ANGLES[captureStep];
      // Record which way they turned first, so the final pose can be required
      // to be the opposite one, whichever direction they actually went.
      if (angle.id !== 'front' && !firstTurnSign && lastCaptureYaw) {
        firstTurnSign = Math.sign(lastCaptureYaw);
      }
      captureStep += 1;

      if (captureStep < CAPTURE_ANGLES.length) {
        // Confirm what was just saved, then announce the next pose. The
        // camera stays live; guidance resumes after a readable pause.
        updateCaptureProgress(`✓ ${angle.done}`);
        el.cameraHint.textContent = 'Getting ready for the next photo…';
        setTimeout(() => {
          if (scanState !== SCAN_STATES.CAMERA || !cameraStream) return;
          alignedSince = 0;
          updateCaptureProgress();
          el.cameraHint.textContent = 'Line your face up with the oval';
          startFaceGuidance();
        }, 1800);
        return;
      }

      // All poses collected.
      canvas.hidden = false;
      video.hidden = true;
      stopCamera();
      setScanState(SCAN_STATES.CAPTURED);
      el.cameraHint.textContent = 'All angles captured. Analysing…';
      startAnalysis();
    }, 'image/jpeg', 0.92);
  }

  // Single place that renders "which photo am I on and what should I do".
  function updateCaptureProgress(message) {
    const total = CAPTURE_ANGLES.length;
    const angle = CAPTURE_ANGLES[Math.min(captureStep, total - 1)];
    const finished = captureStep >= total;

    el.poseCount.textContent = finished
      ? 'All photos taken' : `Photo ${captureStep + 1} of ${total}`;
    el.poseText.textContent = message
      || (finished ? 'Analysing…' : `${angle.arrow} ${angle.title}`.trim());

    el.captureProgress.replaceChildren();
    CAPTURE_ANGLES.forEach((item, index) => {
      const dot = document.createElement('span');
      dot.className = index < captureStep ? 'is-done'
        : index === captureStep ? 'is-current' : '';
      dot.title = item.title;
      el.captureProgress.append(dot);
    });
  }

  // -------------------------------------------------------------------------
  // Image upload, drag and zoom
  // -------------------------------------------------------------------------
  function chooseFile() { el.fileInput.click(); }

  async function handleFile(file) {
    if (!file) return;
    if (!ACCEPTED_TYPES.includes(file.type)) {
      return showError('Only JPEG, PNG and WebP images are accepted.');
    }
    if (file.size > MAX_FILE_BYTES) {
      return showError('The image is larger than 8 MB. Choose a smaller file.');
    }
    const url = URL.createObjectURL(file);
    const ok = await new Promise(resolve => {
      const probe = new Image();
      probe.onload = () => resolve(
        probe.naturalWidth >= MIN_IMAGE_SIDE && probe.naturalHeight >= MIN_IMAGE_SIDE
          ? true : 'small');
      probe.onerror = () => resolve(false);
      probe.src = url;
    });
    if (ok !== true) {
      URL.revokeObjectURL(url);
      return showError(ok === 'small'
        ? 'The image is below the minimum size of 480 × 480 pixels.'
        : 'This image could not be read. Choose another file.');
    }
    stopCamera();
    stopDetectLoop();
    cancelCountdown();
    releasePreviewUrl();
    previewUrl = url;
    uploadedFile = file;
    capturedBlobs = [];
    captureStep = 0;
    imageSource = 'upload';
    el.imagePreview.src = previewUrl;
    resetImageTransform();
    setScanState(SCAN_STATES.IMAGE_SELECTED);
  }

  function resetImageTransform() {
    imageScale = 1;
    imageOffsetX = 0;
    imageOffsetY = 0;
    el.zoom.value = '1';
    applyImageTransform();
  }

  function applyImageTransform() {
    // Keep the image from being dragged fully outside its frame.
    const stage = el.imageStage.getBoundingClientRect();
    const limitX = stage.width * 0.5 * imageScale;
    const limitY = stage.height * 0.5 * imageScale;
    imageOffsetX = Math.max(-limitX, Math.min(limitX, imageOffsetX));
    imageOffsetY = Math.max(-limitY, Math.min(limitY, imageOffsetY));
    el.imagePreview.style.setProperty('--image-x', `${imageOffsetX}px`);
    el.imagePreview.style.setProperty('--image-y', `${imageOffsetY}px`);
    el.imagePreview.style.setProperty('--image-scale', String(imageScale));
  }

  el.imageStage.addEventListener('pointerdown', event => {
    if (scanState !== SCAN_STATES.IMAGE_SELECTED) return;
    dragging = true;
    dragStartX = event.clientX - imageOffsetX;
    dragStartY = event.clientY - imageOffsetY;
    el.imageStage.classList.add('dragging');
    el.imageStage.setPointerCapture(event.pointerId);
  });
  el.imageStage.addEventListener('pointermove', event => {
    if (!dragging) return;
    imageOffsetX = event.clientX - dragStartX;
    imageOffsetY = event.clientY - dragStartY;
    applyImageTransform();
  });
  ['pointerup', 'pointercancel'].forEach(type =>
    el.imageStage.addEventListener(type, () => {
      dragging = false;
      el.imageStage.classList.remove('dragging');
    }));
  el.zoom.addEventListener('input', () => {
    imageScale = Number(el.zoom.value) || 1;
    applyImageTransform();
  });
  el.imageStage.addEventListener('wheel', event => {
    if (scanState !== SCAN_STATES.IMAGE_SELECTED) return;
    event.preventDefault();
    imageScale = Math.max(1, Math.min(3, imageScale - event.deltaY * 0.002));
    el.zoom.value = String(imageScale);
    applyImageTransform();
  }, { passive: false });

  // -------------------------------------------------------------------------
  // Normalised analysis image (camera capture OR uploaded composition)
  // -------------------------------------------------------------------------
  async function buildAnalysisBlobs() {
    if (capturedBlobs.length) {
      return Promise.all(capturedBlobs.map(async blob =>
        normaliseBlob(await createImageBitmap(blob), null)));
    }
    if (uploadedFile) {
      const framed = imageScale !== 1 || imageOffsetX !== 0 || imageOffsetY !== 0;
      // ZERO-LOSS PATH. When the user has not dragged or zoomed there is
      // nothing to re-compose, so the original file is sent untouched.
      // Re-encoding an already-compressed JPEG costs a second generation of
      // loss, and it is precisely the small local colour differences the
      // analysis measures that are softened first: the same photograph scored
      // lower through the browser than when its original bytes were posted.
      // The file has already passed the type, size and dimension checks.
      if (!framed && uploadedFile.size <= MAX_FILE_BYTES) {
        return [uploadedFile];
      }
      const bitmap = await createImageBitmap(uploadedFile);
      return [await normaliseBlob(bitmap, {
        scale: imageScale, offsetX: imageOffsetX, offsetY: imageOffsetY,
        stage: el.imageStage.getBoundingClientRect()
      })];
    }
    throw new Error('No image available');
  }

  function normaliseBlob(bitmap, composition) {
    const canvas = document.createElement('canvas');
    const framed = composition && (composition.scale !== 1
      || composition.offsetX !== 0 || composition.offsetY !== 0);

    if (!framed) {
      // NO USER FRAMING: keep the source aspect ratio.
      //
      // This previously always drew onto a fixed 4:3 canvas, which letterboxed
      // every portrait photograph with black bars down both sides. The face
      // then occupied a fraction of the canvas and lost resolution, and the
      // small colour clusters the redness detector depends on were softened
      // away. Matching the source aspect removes the bars entirely, and
      // capping rather than fixing the size means an image is only ever
      // downsampled, never blown up.
      const fit = Math.min(1, MAX_ANALYSIS_DIM / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(2, Math.round(bitmap.width * fit));
      canvas.height = Math.max(2, Math.round(bitmap.height * fit));
      const context = canvas.getContext('2d');
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    } else {
      // The user has dragged or zoomed, so their composition is defined
      // against the fixed preview frame and must be reproduced on one.
      canvas.width = OUTPUT_W;
      canvas.height = OUTPUT_H;
      const context = canvas.getContext('2d');
      context.imageSmoothingQuality = 'high';
      context.fillStyle = '#000';
      context.fillRect(0, 0, OUTPUT_W, OUTPUT_H);
      const contain = Math.min(OUTPUT_W / bitmap.width, OUTPUT_H / bitmap.height);
      const stageToOutput = OUTPUT_W / composition.stage.width;
      const drawScale = contain * composition.scale;
      const dx = (OUTPUT_W - bitmap.width * drawScale) / 2
        + composition.offsetX * stageToOutput;
      const dy = (OUTPUT_H - bitmap.height * drawScale) / 2
        + composition.offsetY * stageToOutput;
      context.drawImage(bitmap, dx, dy,
        bitmap.width * drawScale, bitmap.height * drawScale);
    }
    bitmap.close?.();

    return new Promise((resolve, reject) => {
      // Quality raised from 0.90: JPEG re-encoding softens exactly the small
      // local colour differences the analysis measures, so the same photograph
      // scored lower through the browser than when sent as the original file.
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Encoding failed')),
        'image/jpeg', ANALYSIS_JPEG_QUALITY);
    });
  }

  // -------------------------------------------------------------------------
  // Analysis request
  // -------------------------------------------------------------------------
  const STAGES = [
    'Uploading image…',
    'Locating the face…',
    'Checking image quality…',
    'Measuring visible skin features…',
    'Preparing suggestions…'
  ];

  async function startAnalysis() {
    let analysisBlobs;
    try {
      analysisBlobs = await buildAnalysisBlobs();
    } catch (error) {
      console.error('Image preparation failed', error);
      return showError('The image could not be prepared for analysis. Try again.');
    }

    setScanState(SCAN_STATES.SCANNING);
    el.progressImage.src = URL.createObjectURL(analysisBlobs[0]);

    const scanStartedAt = performance.now();
    let stageIndex = 0;
    el.stageText.textContent = STAGES[0];
    stageTimer = setInterval(() => {
      stageIndex = Math.min(stageIndex + 1, STAGES.length - 1);
      el.stageText.textContent = STAGES[stageIndex];
    }, MIN_SCAN_MS / STAGES.length);

    // Wait out the remainder of the minimum display time, unless the user
    // cancelled or an error already moved us off the scanning view.
    const holdMinimum = async () => {
      const elapsed = performance.now() - scanStartedAt;
      const remaining = MIN_SCAN_MS - elapsed;
      if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
    };

    const formData = new FormData();
    analysisBlobs.forEach((blob, index) => {
      formData.append('image', blob, `skin-analysis-${index + 1}.jpg`);
    });

    requestController = new AbortController();
    const timeout = setTimeout(() => requestController.abort(), REQUEST_TIMEOUT_MS);

    let payload = null;
    try {
      const response = await fetch(SKIN_ANALYSIS_API, {
        method: 'POST',
        body: formData,
        signal: requestController.signal
      });
      try {
        payload = await response.json();
      } catch {
        throw new Error('invalid_json');
      }
      if (!response.ok || !payload.success) {
        // API validation errors carry a human-readable message. Capture
        // problems also carry a retake hint, which is shown alongside it.
        await holdMinimum();
        if (scanState !== SCAN_STATES.SCANNING) return;
        return showError(
          payload?.message ||
            'The analysis failed. Try another image or select your concerns manually.',
          payload?.hint);
      }
      await holdMinimum();
      if (scanState !== SCAN_STATES.SCANNING) return; // cancelled meanwhile
      renderResults(payload);
    } catch (error) {
      if (error.name === 'AbortError') {
        if (scanState !== SCAN_STATES.SCANNING) return; // user cancelled
        return showError('The analysis timed out. The service may still be starting. Try again.');
      }
      console.error('Skin analysis request failed', error);
      showError('The visual-analysis service is currently unavailable. ' +
        'You can try again or select your concerns manually.');
    } finally {
      clearTimeout(timeout);
      requestController = null;
      if (stageTimer) { clearInterval(stageTimer); stageTimer = null; }
      URL.revokeObjectURL(el.progressImage.src);
    }
  }

  // -------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------
  function renderResults(payload) {
    lastSuggestions = Array.isArray(payload.suggestions) ? payload.suggestions : [];
    lastQuality = payload.quality || null;
    lastAlgorithmVersion = payload.algorithm_version || null;
    el.results.replaceChildren();

    // Capture-quality caveat sits above the result so it cannot be missed.
    // Only shown when there is actual text; an empty banner looks broken.
    const qualityIssues = payload.quality?.warnings || [];
    const qualityText = [payload.quality_hint, ...qualityIssues]
      .filter(Boolean).join(' ').trim();
    el.qualityText.textContent = qualityText;
    el.qualityBanner.hidden = qualityText.length === 0;

    const heading = document.createElement('h3');
    heading.className = 'scan-result-heading';
    heading.textContent = 'Experimental visible-feature signals';
    el.results.append(heading);

    const list = document.createElement('ul');
    list.className = 'scan-signal-list';
    Object.entries(payload.signals || {}).forEach(([key, data]) => {
      const item = document.createElement('li');
      item.className = `scan-signal ${data.level}`;

      const name = document.createElement('span');
      name.className = 'scan-signal-name';
      name.textContent = SIGNAL_LABELS[key] || key;

      // Three coarse segments — a qualitative indicator, deliberately NOT a
      // percentage bar, since the underlying score is not a probability.
      const meter = document.createElement('span');
      meter.className = 'scan-meter';
      meter.setAttribute('role', 'img');
      meter.setAttribute('aria-label', LEVEL_TEXT[data.level] || data.level);
      const filled = LEVEL_STEPS[data.level] || 1;
      for (let step = 1; step <= 3; step += 1) {
        const segment = document.createElement('span');
        segment.className = step <= filled ? 'is-on' : '';
        meter.append(segment);
      }

      const level = document.createElement('span');
      level.className = 'scan-level';
      level.setAttribute('aria-hidden', 'true');
      level.textContent = LEVEL_TEXT[data.level] || data.level;

      item.append(name, meter, level);
      list.append(item);
    });
    el.results.append(list);

    const title = document.createElement('p');
    title.className = 'scan-suggestions-title';
    title.textContent = 'Concerns to confirm yourself';
    el.results.append(title);

    if (!lastSuggestions.length) {
      // A genuine clear result, stated positively. Nothing is invented to
      // fill the space: the technical signals above remain visible, but the
      // decision layer found nothing strong enough to raise as a concern.
      const clear = document.createElement('div');
      clear.className = 'scan-clear';
      const clearTitle = document.createElement('strong');
      clearTitle.textContent = 'No strong visible concerns detected';
      const clearBody = document.createElement('p');
      clearBody.textContent = 'The analysis did not find strong visible '
        + 'acne-like, redness-like or flake-like signals. This is an '
        + 'experimental visual screening result, not a medical assessment.';
      clear.append(clearTitle, clearBody);
      el.results.append(clear);
    } else {
      lastSuggestions.forEach(suggestion => {
        const card = document.createElement('div');
        card.className = 'scan-suggestion';
        const name = document.createElement('strong');
        name.textContent = suggestion.concern;
        const reason = document.createElement('p');
        reason.textContent = suggestion.reason;
        card.append(name, reason, buildFeedbackRow(suggestion));
        el.results.append(card);
      });
    }

    // Caveats the decision layer produced: signals that could not be assessed
    // reliably, and the standing note that dehydration is not something a
    // photograph can establish.
    (payload.assessment_notes || []).forEach(text => {
      const note = document.createElement('p');
      note.className = 'scan-assessment-note';
      note.textContent = text;
      el.results.append(note);
    });

    setScanState(SCAN_STATES.RESULT);
  }

  // Per-condition feedback. The user is the authority on their own skin, so
  // disagreeing must be as easy as agreeing.
  function buildFeedbackRow(suggestion) {
    const row = document.createElement('div');
    row.className = 'scan-feedback';

    const label = document.createElement('span');
    label.className = 'scan-feedback-label';
    label.textContent = 'Does this match your skin?';
    row.append(label);

    const buttons = document.createElement('div');
    buttons.className = 'scan-feedback-buttons';

    const options = [
      { verdict: 'correct', text: 'This looks correct' },
      { verdict: 'incorrect', text: 'I don’t have this' },
      { verdict: 'unsure', text: 'Not sure' }
    ];
    options.forEach(option => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'scan-feedback-btn';
      button.textContent = option.text;
      button.addEventListener('click', () => {
        recordFeedback({
          condition: suggestion.concern,
          verdict: option.verdict,
          confidence_score: suggestion.score,
          lighting_score: lastQuality?.lighting_score ?? null,
          quality_codes: lastQuality?.codes || [],
          image_source: imageSource,
          timestamp: new Date().toISOString(),
          algorithm_version: lastAlgorithmVersion
        });
        [...buttons.children].forEach(b => b.classList.remove('is-chosen'));
        button.classList.add('is-chosen');
        row.dataset.recorded = 'true';
      });
      buttons.append(button);
    });

    // Applies the suggestions and closes, so the selection can be edited in
    // the main consultation panel using the existing controls.
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'scan-feedback-btn is-edit';
    edit.textContent = 'Edit selection';
    edit.addEventListener('click', applyResults);
    buttons.append(edit);

    row.append(buttons);
    return row;
  }

  function applyResults() {
    const concerns = lastSuggestions.map(item => item.concern);
    // Bridge into the existing selector (defined in app.js). Selection only —
    // the user reviews, edits and submits through the untouched flow.
    if (typeof window.cosmoApplyConcerns === 'function' && concerns.length) {
      window.cosmoApplyConcerns(concerns);
    }
    closeModal();
  }

  // -------------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------------
  function showError(message, hint) {
    stopCamera();
    stopDetectLoop();
    cancelCountdown();
    if (stageTimer) { clearInterval(stageTimer); stageTimer = null; }
    el.errorBox.replaceChildren();
    const main = document.createElement('p');
    main.className = 'scan-error-main';
    main.textContent = message;
    el.errorBox.append(main);
    if (hint) {
      const extra = document.createElement('p');
      extra.className = 'scan-error-hint';
      extra.textContent = hint;
      el.errorBox.append(extra);
    }
    setScanState(SCAN_STATES.ERROR);
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------
  el.openBtn.addEventListener('click', openModal);
  el.closeBtn.addEventListener('click', closeModal);
  el.cancelBtn.addEventListener('click', closeModal);
  el.overlay.addEventListener('pointerdown', event => {
    if (event.target === el.overlay) closeModal();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !el.overlay.hidden) closeModal();
  });

  el.cameraBtn.addEventListener('click', openCamera);
  el.uploadBtn.addEventListener('click', chooseFile);
  el.switchUploadBtn.addEventListener('click', () => {
    stopCamera();
    stopDetectLoop();
    cancelCountdown();
    chooseFile();
  });
  el.fileInput.addEventListener('change', () => {
    handleFile(el.fileInput.files?.[0]);
    el.fileInput.value = ''; // allow re-selecting the same file
  });
  el.captureBtn.addEventListener('click', () => {
    cancelCountdown();
    captureFrame();
  });
  el.analyseBtn.addEventListener('click', startAnalysis);
  el.replaceBtn.addEventListener('click', chooseFile);
  el.resetPosBtn.addEventListener('click', resetImageTransform);
  // "Retake" must follow however the image arrived. It previously always
  // opened the camera, so after an upload it asked for camera permission
  // instead of letting the user choose another picture.
  el.retakeBtn.addEventListener('click', restartCapture);
  el.retryBtn.addEventListener('click', restartCapture);

  function restartCapture() {
    capturedBlobs = [];
    captureStep = 0;
    firstTurnSign = 0;
    lastCaptureYaw = 0;
    el.qualityBanner.hidden = true;
    el.errorBox.replaceChildren();
    el.results.replaceChildren();
    if (imageSource === 'upload') {
      // Go straight back to the picker so a different photo can be chosen.
      chooseFile();
    } else {
      openCamera();
    }
  }
  el.useBtn.addEventListener('click', applyResults);
  // Retake from the quality banner: back to the camera, or pick a new file.
  el.qualityRetakeBtn.addEventListener('click', restartCapture);
})();
