import { FilesetResolver, FaceLandmarker, ObjectDetector } from "./vendor/tasks-vision/vision_bundle.mjs";

const APP_BASE_URL = new URL("./", import.meta.url);
const assetUrl = (path) => new URL(path, APP_BASE_URL).href;
const $ = (selector) => document.querySelector(selector);
const video = $("#camera-video");
const canvas = $("#overlay-canvas");
const ctx = canvas.getContext("2d");
const elements = {
  placeholder: $("#camera-placeholder"), live: $("#live-badge"), fps: $("#fps-label"), banner: $("#reason-banner"),
  status: $("#attention-status"), detail: $("#attention-detail"), countdown: $("#countdown-value"), ring: $("#countdown-ring"),
  face: $("#face-metric"), head: $("#head-metric"), phone: $("#phone-metric"), alerts: $("#alert-count"),
  start: $("#start-button"), pause: $("#pause-button"), calibrate: $("#calibrate-button"), test: $("#test-sound-button"),
  camera: $("#camera-select"), duration: $("#duration-select"), volume: $("#volume-range"), volumeLabel: $("#volume-label"),
  volumeDown: $("#volume-down-button"), volumeUp: $("#volume-up-button"), beepCount: $("#beep-count-select"),
  phoneToggle: $("#phone-toggle"), objectsToggle: $("#objects-toggle"), dazeToggle: $("#daze-toggle"),
  continuousToggle: $("#continuous-alert-toggle"), wakeToggle: $("#wake-lock-toggle"),
  boxesToggle: $("#boxes-toggle"), log: $("#event-log"), toast: $("#toast"),
};

const state = {
  stream: null, faceLandmarker: null, objectDetector: null, running: false, paused: false, loading: false,
  audioContext: null, activeOscillators: new Set(), alertOscillators: new Set(), wakeLock: null,
  objectDetectorUnavailable: false, objectLoading: false,
  lastFaceRun: 0, lastObjectRun: 0, lastFrameTime: 0, faceResult: null, objectResult: null,
  facePresent: false, faceSeenAt: 0, personSeenAt: 0, phoneSeenAt: 0, phoneHits: 0, distractorSeenAt: 0, distractorHits: 0,
  yaw: 0, yawOffset: 0, roll: 0, rollOffset: 0, lastFacePoint: null, lastGazePoint: null,
  lastMotionAt: performance.now(), lastEyeMotionAt: performance.now(), lastBlinkAt: performance.now(), blinkActive: false,
  reason: "idle", candidateReason: "", candidateSince: 0, episodeAlerted: false, lastAlertAt: 0, alerts: 0, log: [],
  fpsFrames: 0, fpsStarted: performance.now(), inferenceFps: 0,
  settings: { version: 6, duration: 20, sensitivity: "medium", volume: 55, beepCount: 2, phone: true, objects: true, daze: true, continuous: false, keepAwake: true, boxes: true },
};

const reasonCopy = {
  idle: ["未开始", "启动后将显示可观察行为判断", "等待启动", "neutral"],
  loading: ["正在准备", "正在载入本地视觉模型", "模型载入中", "neutral"],
  focused: ["状态正常", "面向书桌区域，未发现明显分心行为", "专注状态", "focused"],
  turned: ["持续看向侧面", "头部明显偏离校准方向，达到时限后提醒", "检测到长时间转头", "warning"],
  phone: ["检测到手机", "画面中识别到手机，达到时限后提醒", "检测到手机", "warning"],
  object: ["疑似在玩东西", "识别到常见非学习物品，达到时限后提醒", "疑似在玩东西", "warning"],
  dazed: ["疑似长时间发呆", "头部和视线长时间基本不动，请结合实际情况判断", "疑似发呆", "warning"],
  absent: ["离开画面", "没有检测到人脸或人体，提醒音已停止", "未检测到孩子 · 保持静音", "neutral"],
  occluded: ["脸部暂时不可见", "检测到人体但没有清晰人脸，提醒音保持停止", "没有看到脸部 · 保持静音", "neutral"],
  paused: ["判断已暂停", "摄像头保持开启，但不会判断和提醒", "已暂停", "neutral"],
  alert: ["已发出提醒", "已播放提示音，恢复正常后才会再次提醒", "哔哔 · 请注意", "alert"],
};

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("focus-reminder-settings"));
    if (saved) {
      Object.assign(state.settings, saved);
      if (saved.version !== 6) {
        state.settings.phone = true;
        state.settings.objects = true;
        state.settings.daze = true;
        state.settings.beepCount = 2;
        state.settings.continuous = false;
        state.settings.keepAwake = true;
      }
    }
  } catch { /* Ignore unavailable storage. */ }
  state.settings.version = 6;
  elements.duration.value = String(state.settings.duration);
  elements.volume.value = String(state.settings.volume);
  elements.volumeLabel.textContent = `${state.settings.volume}%`;
  elements.beepCount.value = String(state.settings.beepCount);
  elements.phoneToggle.checked = state.settings.phone;
  elements.objectsToggle.checked = state.settings.objects;
  elements.dazeToggle.checked = state.settings.daze;
  elements.continuousToggle.checked = state.settings.continuous;
  elements.wakeToggle.checked = state.settings.keepAwake;
  elements.boxesToggle.checked = state.settings.boxes;
  document.querySelectorAll("[data-sensitivity]").forEach((button) => button.classList.toggle("active", button.dataset.sensitivity === state.settings.sensitivity));
}

function saveSettings() {
  try { localStorage.setItem("focus-reminder-settings", JSON.stringify(state.settings)); } catch { /* Ignore. */ }
}

function toast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => elements.toast.classList.remove("show"), 2200);
}

async function requestWakeLock() {
  if (!state.settings.keepAwake || !state.running || document.visibilityState !== "visible") return;
  if (!("wakeLock" in navigator)) {
    toast("当前浏览器不支持保持唤醒，请在 Windows 中关闭自动睡眠");
    return;
  }
  try {
    if (!state.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request("screen");
      state.wakeLock.addEventListener("release", () => { state.wakeLock = null; });
    }
  } catch (error) {
    console.warn("Screen wake lock unavailable.", error);
  }
}

async function releaseWakeLock() {
  if (!state.wakeLock) return;
  try { await state.wakeLock.release(); } catch { /* Already released. */ }
  state.wakeLock = null;
}

async function createModels() {
  if (state.faceLandmarker) return;
  setReason("loading");
  const appleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  elements.detail.textContent = appleMobile
    ? "首次使用正在下载人脸模型，完成后会缓存；请稍候"
    : "正在初始化本地视觉模型";
  const vision = await FilesetResolver.forVisionTasks(assetUrl("vendor/tasks-vision/wasm"));
  const faceOptions = {
    baseOptions: { modelAssetPath: assetUrl("models/face_landmarker.task"), delegate: appleMobile ? "CPU" : "GPU" },
    runningMode: "VIDEO", numFaces: 1, minFaceDetectionConfidence: 0.55,
    minFacePresenceConfidence: 0.55, minTrackingConfidence: 0.55, outputFaceBlendshapes: true,
  };
  try {
    state.faceLandmarker = await FaceLandmarker.createFromOptions(vision, faceOptions);
  } catch (firstError) {
    if (faceOptions.baseOptions.delegate === "CPU") {
      throw new Error(`人脸模型无法加载：${firstError?.message || firstError?.name || "未知错误"}`);
    }
    console.warn("Face model GPU initialization failed; retrying on CPU.", firstError);
    faceOptions.baseOptions.delegate = "CPU";
    try {
      state.faceLandmarker = await FaceLandmarker.createFromOptions(vision, faceOptions);
    } catch (cpuError) {
      throw new Error(`人脸模型无法加载：${cpuError?.message || cpuError?.name || "未知错误"}`);
    }
  }

  loadObjectModel(vision, appleMobile);
}

async function loadObjectModel(vision, appleMobile) {
  if (state.objectDetector || state.objectLoading || state.objectDetectorUnavailable) return;
  state.objectLoading = true;
  elements.phone.textContent = "模型载入中";
  const objectOptions = {
    baseOptions: {
      modelAssetPath: appleMobile ? assetUrl("models/efficientdet_lite0_uint8.tflite") : assetUrl("models/efficientdet_lite2_int8.tflite"),
      delegate: "CPU",
    },
    runningMode: "VIDEO", scoreThreshold: 0.08, maxResults: 20,
  };
  try {
    state.objectDetector = await ObjectDetector.createFromOptions(vision, objectOptions);
    elements.phone.textContent = "未检测";
    toast("手机和玩物识别已在后台准备完成");
  } catch (accurateModelError) {
    if (appleMobile) {
      console.warn("Phone detection disabled because the mobile model could not load.", accurateModelError);
      state.objectDetectorUnavailable = true;
      elements.phoneToggle.disabled = true;
      elements.objectsToggle.disabled = true;
      elements.phone.textContent = "暂不可用";
      return;
    }
    console.warn("High-accuracy object model failed; retrying with Lite0.", accurateModelError);
    objectOptions.baseOptions.modelAssetPath = assetUrl("models/efficientdet_lite0_uint8.tflite");
    try {
      state.objectDetector = await ObjectDetector.createFromOptions(vision, objectOptions);
      elements.phone.textContent = "未检测";
    } catch (cpuError) {
      console.warn("Phone detection disabled because the object model could not load.", cpuError);
      state.objectDetector = null;
      state.objectDetectorUnavailable = true;
      elements.phoneToggle.disabled = true;
      elements.phone.textContent = "暂不可用";
      toast("摄像头已启动；手机识别暂不可用，其他提醒功能正常");
    }
  } finally {
    state.objectLoading = false;
  }
}

async function startCamera(deviceId = "") {
  if (state.loading) return;
  state.loading = true;
  elements.start.disabled = true;
  elements.start.textContent = "正在启动…";
  let startupStage = "camera";
  try {
    stopStream();
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: deviceId ? { exact: deviceId } : undefined, facingMode: deviceId ? undefined : { ideal: "user" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
      audio: false,
    });
    startupStage = "video";
    video.srcObject = state.stream;
    await video.play();
    elements.placeholder.classList.add("hidden");
    elements.live.classList.add("active");
    elements.live.innerHTML = "<i></i>本地分析中";
    elements.fps.textContent = "载入模型…";
    await populateCameras();
    startupStage = "models";
    await createModels();
    state.running = true;
    state.paused = false;
    state.candidateSince = 0;
    state.candidateReason = "";
    state.episodeAlerted = false;
    state.lastMotionAt = performance.now();
    state.lastEyeMotionAt = performance.now();
    state.lastBlinkAt = performance.now();
    state.lastFacePoint = null;
    state.lastGazePoint = null;
    state.phoneHits = 0;
    state.phoneSeenAt = 0;
    state.distractorHits = 0;
    state.distractorSeenAt = 0;
    elements.pause.disabled = false;
    elements.calibrate.disabled = false;
    elements.camera.disabled = false;
    elements.start.textContent = "关闭摄像头";
    setReason("focused");
    requestAnimationFrame(analyzeLoop);
    requestWakeLock();
    toast("摄像头与本地 AI 已启动");
  } catch (error) {
    console.error(error);
    stopStream();
    elements.placeholder.classList.remove("hidden");
    setReason("idle");
    let message;
    if (startupStage === "models") {
      message = `摄像头已打开，但本地 AI 加载失败：${error?.message || error?.name || "未知错误"}`;
    } else if (error?.name === "NotAllowedError") {
      message = "未获得摄像头权限，请在浏览器地址栏允许摄像头";
    } else if (error?.name === "NotReadableError") {
      message = "摄像头被其他程序占用，或被键盘上的摄像头开关关闭";
    } else if (error?.name === "NotFoundError") {
      message = "Windows 没有找到可用的摄像头";
    } else {
      message = `摄像头启动失败（${error?.name || "未知错误"}）：${error?.message || "无法启动视频"}`;
    }
    toast(message);
    elements.detail.textContent = message;
  } finally {
    state.loading = false;
    elements.start.disabled = false;
    if (!state.running) elements.start.textContent = "开启摄像头";
  }
}

function stopStream() {
  state.running = false;
  if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
  state.stream = null;
}

function turnOffCamera() {
  stopStream();
  stopAllBeeps();
  releaseWakeLock();
  video.srcObject = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  elements.placeholder.classList.remove("hidden");
  elements.live.classList.remove("active");
  elements.live.innerHTML = "<i></i>待机";
  elements.fps.textContent = "摄像头已关闭";
  elements.pause.disabled = true;
  elements.calibrate.disabled = true;
  elements.camera.disabled = true;
  elements.pause.textContent = "暂停判断";
  elements.start.textContent = "开启摄像头";
  state.paused = false;
  state.candidateSince = 0;
  state.candidateReason = "";
  state.episodeAlerted = false;
  setReason("idle");
  toast("摄像头已关闭");
}

async function populateCameras() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput");
  const current = state.stream?.getVideoTracks()[0]?.getSettings().deviceId || "";
  elements.camera.innerHTML = devices.map((device, index) => `<option value="${device.deviceId}" ${device.deviceId === current ? "selected" : ""}>${device.label || `摄像头 ${index + 1}`}</option>`).join("");
}

function analyzeLoop(now) {
  if (!state.running) return;
  try {
    if (!state.paused && video.readyState >= 2 && video.currentTime !== state.lastFrameTime) {
      state.lastFrameTime = video.currentTime;
      if (now - state.lastFaceRun >= 150) {
        state.lastFaceRun = now;
        state.faceResult = state.faceLandmarker.detectForVideo(video, now);
        processFace(state.faceResult, now);
        state.fpsFrames += 1;
      }
      if (state.objectDetector && now - state.lastObjectRun >= 650) {
        state.lastObjectRun = now;
        try {
          state.objectResult = state.objectDetector.detectForVideo(video, now);
          processObjects(state.objectResult, now);
        } catch (objectError) {
          console.warn("Phone detection stopped after a runtime error.", objectError);
          state.objectDetector = null;
          state.objectDetectorUnavailable = true;
          elements.phone.textContent = "暂不可用";
        }
      }
      evaluateAttention(now);
      drawOverlay();
      updateFps(now);
    }
  } catch (error) {
    console.error("AI analysis frame failed.", error);
    elements.fps.textContent = `AI 分析异常：${error?.message || error?.name || "未知错误"}`;
  } finally {
    if (state.running) requestAnimationFrame(analyzeLoop);
  }
}

function processFace(result, now) {
  const landmarks = result?.faceLandmarks?.[0];
  state.facePresent = Boolean(landmarks?.length);
  if (!state.facePresent) {
    state.lastFacePoint = null;
    state.lastGazePoint = null;
    state.lastMotionAt = now;
    state.lastEyeMotionAt = now;
    state.lastBlinkAt = now;
    return;
  }
  state.faceSeenAt = now;
  const leftEye = landmarks[33];
  const rightEye = landmarks[263];
  const nose = landmarks[1];
  const eyeDistance = Math.max(0.01, Math.abs(rightEye.x - leftEye.x));
  state.yaw = (nose.x - ((leftEye.x + rightEye.x) / 2)) / eyeDistance;
  state.roll = Math.atan2(rightEye.y - leftEye.y, rightEye.x - leftEye.x);

  if (state.lastFacePoint) {
    const movement = Math.hypot(nose.x - state.lastFacePoint.x, nose.y - state.lastFacePoint.y);
    if (movement > 0.008) state.lastMotionAt = now;
  }
  state.lastFacePoint = { x: nose.x, y: nose.y };

  const blendshapes = result?.faceBlendshapes?.[0]?.categories || [];
  const blinkLeft = blendshapes.find((item) => item.categoryName === "eyeBlinkLeft")?.score || 0;
  const blinkRight = blendshapes.find((item) => item.categoryName === "eyeBlinkRight")?.score || 0;
  const blinking = Math.max(blinkLeft, blinkRight) > 0.45;
  if (blinking && !state.blinkActive) state.lastBlinkAt = now;
  state.blinkActive = blinking;

  const leftIris = landmarks[468];
  const rightIris = landmarks[473];
  if (!blinking && leftIris && rightIris) {
    const leftInner = landmarks[133], rightInner = landmarks[362];
    const leftTop = landmarks[159], leftBottom = landmarks[145];
    const rightTop = landmarks[386], rightBottom = landmarks[374];
    const leftWidth = Math.max(0.005, Math.abs(leftInner.x - leftEye.x));
    const rightWidth = Math.max(0.005, Math.abs(rightInner.x - rightEye.x));
    const leftHeight = Math.max(0.003, Math.abs(leftBottom.y - leftTop.y));
    const rightHeight = Math.max(0.003, Math.abs(rightBottom.y - rightTop.y));
    const gazePoint = {
      x: ((leftIris.x - (leftEye.x + leftInner.x) / 2) / leftWidth
        + (rightIris.x - (rightEye.x + rightInner.x) / 2) / rightWidth) / 2,
      y: ((leftIris.y - (leftTop.y + leftBottom.y) / 2) / leftHeight
        + (rightIris.y - (rightTop.y + rightBottom.y) / 2) / rightHeight) / 2,
    };
    if (state.lastGazePoint && Math.hypot(gazePoint.x - state.lastGazePoint.x, gazePoint.y - state.lastGazePoint.y) > 0.055) {
      state.lastEyeMotionAt = now;
    }
    state.lastGazePoint = gazePoint;
  } else if (!leftIris || !rightIris) {
    state.lastEyeMotionAt = now;
    state.lastGazePoint = null;
  }
}

function phoneBoxLooksValid(box) {
  if (!box || !video.videoWidth || !video.videoHeight) return false;
  const shortSide = Math.max(1, Math.min(box.width, box.height));
  const longSide = Math.max(box.width, box.height);
  const areaRatio = (box.width * box.height) / (video.videoWidth * video.videoHeight);
  const relativeShortSide = shortSide / Math.min(video.videoWidth, video.videoHeight);
  return longSide / shortSide <= 3.2 && areaRatio >= 0.002 && relativeShortSide >= 0.035;
}

function processObjects(result, now) {
  let person = false;
  let phone = false;
  let phoneScore = 0;
  let distractor = null;
  const distractorLabels = {
    remote: "遥控器", "sports ball": "球", "teddy bear": "玩具", frisbee: "飞盘",
    skateboard: "滑板", "baseball bat": "球棒", "tennis racket": "球拍",
  };
  for (const detection of result?.detections || []) {
    const category = detection.categories?.[0];
    const name = (category?.categoryName || category?.displayName || "").toLowerCase();
    if (name === "person") person = true;
    if (name.includes("phone") || name.includes("mobile") || name.includes("cellular")) {
      const box = detection.boundingBox;
      const nose = state.faceResult?.faceLandmarks?.[0]?.[1];
      const noseX = nose ? nose.x * video.videoWidth : -1;
      const noseY = nose ? nose.y * video.videoHeight : -1;
      const overlapsFaceCenter = noseX >= box.originX && noseX <= box.originX + box.width
        && noseY >= box.originY && noseY <= box.originY + box.height;
      if (!overlapsFaceCenter && phoneBoxLooksValid(box)) {
        phone = true;
        phoneScore = Math.max(phoneScore, category?.score || 0);
      }
    }
    if (distractorLabels[name] && (category?.score || 0) >= 0.18) {
      const box = detection.boundingBox;
      const facePoints = state.faceResult?.faceLandmarks?.[0];
      let nearFace = false;
      if (facePoints?.length) {
        const xs = facePoints.map((point) => point.x * video.videoWidth);
        const ys = facePoints.map((point) => point.y * video.videoHeight);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minY = Math.min(...ys), maxY = Math.max(...ys);
        const faceWidth = Math.max(1, maxX - minX);
        const faceHeight = Math.max(1, maxY - minY);
        const centerX = box.originX + box.width / 2;
        const centerY = box.originY + box.height / 2;
        nearFace = centerX >= minX - faceWidth * 1.4
          && centerX <= maxX + faceWidth * 1.4
          && centerY >= minY - faceHeight * 0.5
          && centerY <= maxY + faceHeight * 2;
      }
      if (nearFace) {
        if (!distractor || category.score > distractor.score) distractor = { label: distractorLabels[name], score: category.score };
      }
    }
  }
  if (person) state.personSeenAt = now;
  if (phone && phoneScore >= 0.22) {
    state.phoneHits = Math.min(5, state.phoneHits + 1);
    state.phoneScore = phoneScore;
  } else {
    state.phoneHits = Math.max(0, state.phoneHits - 1);
  }
  if (state.phoneHits >= 3) state.phoneSeenAt = now;
  if (distractor) {
    state.distractorHits = Math.min(4, state.distractorHits + 1);
    state.distractorLabel = distractor.label;
    state.distractorScore = distractor.score;
  } else {
    state.distractorHits = Math.max(0, state.distractorHits - 1);
  }
  if (state.distractorHits >= 2) state.distractorSeenAt = now;
}

function sensitivityThreshold() {
  return { low: 0.68, medium: 0.52, high: 0.38 }[state.settings.sensitivity];
}

function rollThreshold() {
  return { low: 0.48, medium: 0.34, high: 0.24 }[state.settings.sensitivity];
}

function evaluateAttention(now) {
  const personRecent = now - state.personSeenAt < 1800;
  const phoneRecent = now - state.phoneSeenAt < 3000;
  const distractorRecent = now - state.distractorSeenAt < 2500;
  const correctedYaw = state.yaw - state.yawOffset;
  const correctedRoll = state.roll - state.rollOffset;
  const headDeviated = Math.abs(correctedYaw) > sensitivityThreshold()
    || Math.abs(correctedRoll) > rollThreshold();
  const dazeCandidate = state.settings.daze && state.facePresent
    && now - state.lastMotionAt > 5000
    && now - state.lastEyeMotionAt > 5000;
  let reason = "focused";
  if (state.settings.phone && phoneRecent) reason = "phone";
  else if (state.settings.objects && distractorRecent) reason = "object";
  else if (state.facePresent && headDeviated) reason = "turned";
  else if (dazeCandidate) reason = "dazed";
  else if (!state.facePresent && personRecent) reason = "occluded";
  else if (!state.facePresent && !personRecent) reason = "absent";

  const distracting = ["phone", "object", "turned", "dazed"].includes(reason);
  if (!distracting) {
    stopBeep();
    state.candidateSince = 0;
    state.candidateReason = "";
    state.episodeAlerted = false;
    state.lastAlertAt = 0;
  } else if (!state.candidateSince || state.candidateReason !== reason) {
    state.candidateSince = now;
    state.candidateReason = reason;
    state.episodeAlerted = false;
    state.lastAlertAt = 0;
  }

  const elapsed = state.candidateSince ? (now - state.candidateSince) / 1000 : 0;
  const requiredDuration = reason === "dazed" ? 25 : state.settings.duration;
  const remaining = Math.max(0, requiredDuration - elapsed);
  const silenceWhenAway = state.settings.continuous && reason === "absent";
  if (distracting && elapsed >= requiredDuration && !state.episodeAlerted && !silenceWhenAway) {
    state.episodeAlerted = true;
    state.lastAlertAt = now;
    state.alerts += 1;
    playBeep(true);
    addLog(reason, Math.round(elapsed));
    setReason("alert");
  } else if (state.episodeAlerted && state.settings.continuous && reason !== "absent" && now - state.lastAlertAt >= 6000) {
    state.lastAlertAt = now;
    state.alerts += 1;
    playBeep(true);
  } else if (silenceWhenAway) {
    setReason("absent");
  } else if (!state.episodeAlerted) {
    setReason(reason, remaining);
  }

  elements.face.textContent = state.facePresent ? "已检测" : (personRecent ? "被遮挡" : "未检测");
  elements.head.textContent = state.facePresent
    ? (Math.abs(correctedRoll) > rollThreshold() ? "向肩膀歪头" : (Math.abs(correctedYaw) > sensitivityThreshold() ? "偏向侧面" : "正常"))
    : "—";
  elements.phone.textContent = state.objectDetectorUnavailable
    ? "暂不可用"
    : (state.objectLoading ? "模型载入中"
    : (phoneRecent
      ? `手机 ${Math.round((state.phoneScore || 0) * 100)}%`
      : (distractorRecent ? `${state.distractorLabel} ${Math.round((state.distractorScore || 0) * 100)}%` : "未检测")));
  elements.alerts.textContent = `${state.alerts} 次`;
  elements.countdown.textContent = distracting && !state.episodeAlerted ? Math.ceil(remaining) : "—";
  elements.ring.classList.toggle("warning", distracting && !state.episodeAlerted);
  elements.ring.classList.toggle("alert", state.episodeAlerted);
}

function setReason(reason) {
  state.reason = reason;
  const [title, detail, banner, style] = reasonCopy[reason] || reasonCopy.idle;
  elements.status.textContent = title;
  elements.detail.textContent = detail;
  elements.banner.textContent = banner;
  elements.banner.className = `reason-banner ${style}`;
}

function drawOverlay() {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) return;
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  ctx.clearRect(0, 0, width, height);
  if (!state.settings.boxes) return;

  const landmarks = state.faceResult?.faceLandmarks?.[0];
  if (landmarks) {
    ctx.fillStyle = "#53e3a0";
    for (const index of [1, 33, 263, 61, 291]) {
      const point = landmarks[index];
      ctx.beginPath(); ctx.arc(point.x * width, point.y * height, 3.5, 0, Math.PI * 2); ctx.fill();
    }
  }
  for (const detection of state.objectResult?.detections || []) {
    const category = detection.categories?.[0];
    const name = (category?.categoryName || category?.displayName || "").toLowerCase();
    const objectNames = { remote: "遥控器", "sports ball": "球", "teddy bear": "玩具", frisbee: "飞盘", skateboard: "滑板", "baseball bat": "球棒", "tennis racket": "球拍" };
    const isPhone = name.includes("phone") || name.includes("mobile");
    const box = detection.boundingBox;
    if (isPhone && ((category?.score || 0) < 0.22 || !phoneBoxLooksValid(box))) continue;
    if (name !== "person" && !isPhone && !objectNames[name]) continue;
    ctx.strokeStyle = name === "person" ? "#53e3a0" : "#ffbf55";
    ctx.lineWidth = 3;
    ctx.strokeRect(box.originX, box.originY, box.width, box.height);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.font = "bold 17px sans-serif";
    const label = name === "person" ? "人物" : (isPhone ? "手机" : objectNames[name]);
    ctx.fillText(label, box.originX + 5, Math.max(20, box.originY - 6));
  }
}

function updateFps(now) {
  if (now - state.fpsStarted < 2000) return;
  state.inferenceFps = state.fpsFrames / ((now - state.fpsStarted) / 1000);
  elements.fps.textContent = `本地 AI ${state.inferenceFps.toFixed(1)} 帧/秒`;
  state.fpsFrames = 0;
  state.fpsStarted = now;
}

function ensureAudio() {
  if (!state.audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    state.audioContext = new AudioContextClass();
  }
  if (state.audioContext.state === "suspended") state.audioContext.resume();
  return state.audioContext;
}

function stopBeep() {
  for (const oscillator of state.alertOscillators) {
    try { oscillator.stop(); } catch { /* Already stopped. */ }
    try { oscillator.disconnect(); } catch { /* Already disconnected. */ }
  }
  state.alertOscillators.clear();
}

function stopAllBeeps() {
  stopBeep();
  for (const oscillator of state.activeOscillators) {
    try { oscillator.stop(); } catch { /* Already stopped. */ }
    try { oscillator.disconnect(); } catch { /* Already disconnected. */ }
  }
  state.activeOscillators.clear();
}

function playBeep(asAlert = false) {
  const audio = ensureAudio();
  if (!audio) return toast("当前浏览器不支持提醒音");
  const volume = state.settings.volume / 100 * 0.22;
  const start = audio.currentTime;
  const count = Math.min(10, Math.max(2, Number(state.settings.beepCount) || 2));
  for (const offset of Array.from({ length: count }, (_, index) => index * 0.34)) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(880, start + offset);
    oscillator.frequency.exponentialRampToValueAtTime(1100, start + offset + 0.12);
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, volume), start + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.22);
    oscillator.connect(gain).connect(audio.destination);
    const oscillatorSet = asAlert ? state.alertOscillators : state.activeOscillators;
    oscillatorSet.add(oscillator);
    oscillator.addEventListener("ended", () => oscillatorSet.delete(oscillator), { once: true });
    oscillator.start(start + offset);
    oscillator.stop(start + offset + 0.24);
  }
}

function addLog(reason, seconds) {
  const labels = { phone: "检测到手机", object: `疑似在玩${state.distractorLabel || "东西"}`, dazed: "疑似长时间发呆", turned: "持续看向侧面", occluded: "脸部长时间不可见", absent: "离开画面" };
  state.log.unshift({ label: labels[reason] || "专注提醒", seconds, time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) });
  state.log = state.log.slice(0, 30);
  renderLog();
}

function renderLog() {
  elements.log.innerHTML = state.log.length ? state.log.map((item) => `<div class="log-item"><i></i><div><strong>${item.label}</strong><span>持续约 ${item.seconds} 秒</span></div><time>${item.time}</time></div>`).join("") : '<div class="empty-log">还没有提醒记录</div>';
}

elements.start.addEventListener("click", () => {
  if (state.running) {
    turnOffCamera();
    return;
  }
  ensureAudio();
  startCamera(elements.camera.value);
});
elements.pause.addEventListener("click", () => {
  state.paused = !state.paused;
  elements.pause.textContent = state.paused ? "继续判断" : "暂停判断";
  if (state.paused) { stopBeep(); state.candidateSince = 0; state.candidateReason = ""; state.episodeAlerted = false; setReason("paused"); ctx.clearRect(0,0,canvas.width,canvas.height); }
  else { setReason("focused"); state.fpsStarted = performance.now(); state.fpsFrames = 0; }
});
elements.calibrate.addEventListener("click", () => {
  if (!state.facePresent) return toast("请先正对摄像头，确保能看到脸部");
  state.yawOffset = state.yaw;
  state.rollOffset = state.roll;
  state.candidateSince = 0;
  state.candidateReason = "";
  state.episodeAlerted = false;
  state.lastMotionAt = performance.now();
  state.lastEyeMotionAt = performance.now();
  state.lastBlinkAt = performance.now();
  state.lastGazePoint = null;
  toast("已记录当前方向为正常方向");
});
elements.test.addEventListener("click", () => { ensureAudio(); playBeep(); toast("已播放测试提醒音"); });
elements.camera.addEventListener("change", () => { if (state.running) startCamera(elements.camera.value); });
elements.duration.addEventListener("change", () => { state.settings.duration = Number(elements.duration.value); saveSettings(); });
elements.volume.addEventListener("input", () => { state.settings.volume = Number(elements.volume.value); elements.volumeLabel.textContent = `${state.settings.volume}%`; saveSettings(); });
function changeVolume(delta) {
  state.settings.volume = Math.min(100, Math.max(10, state.settings.volume + delta));
  elements.volume.value = String(state.settings.volume);
  elements.volumeLabel.textContent = `${state.settings.volume}%`;
  saveSettings();
  playBeep();
}
elements.volumeDown.addEventListener("click", () => changeVolume(-10));
elements.volumeUp.addEventListener("click", () => changeVolume(10));
elements.beepCount.addEventListener("change", () => { state.settings.beepCount = Number(elements.beepCount.value); saveSettings(); });
elements.phoneToggle.addEventListener("change", () => { state.settings.phone = elements.phoneToggle.checked; saveSettings(); });
elements.objectsToggle.addEventListener("change", () => { state.settings.objects = elements.objectsToggle.checked; saveSettings(); });
elements.dazeToggle.addEventListener("change", () => { state.settings.daze = elements.dazeToggle.checked; saveSettings(); });
elements.continuousToggle.addEventListener("change", () => {
  state.settings.continuous = elements.continuousToggle.checked;
  saveSettings();
  toast(state.settings.continuous ? "已开启持续提醒；恢复正常或离开画面后停止" : "已关闭持续提醒");
});
elements.wakeToggle.addEventListener("change", () => {
  state.settings.keepAwake = elements.wakeToggle.checked;
  saveSettings();
  if (state.settings.keepAwake) requestWakeLock();
  else releaseWakeLock();
});
elements.boxesToggle.addEventListener("change", () => { state.settings.boxes = elements.boxesToggle.checked; saveSettings(); if (!state.settings.boxes) ctx.clearRect(0,0,canvas.width,canvas.height); });
document.querySelectorAll("[data-sensitivity]").forEach((button) => button.addEventListener("click", () => {
  state.settings.sensitivity = button.dataset.sensitivity;
  document.querySelectorAll("[data-sensitivity]").forEach((item) => item.classList.toggle("active", item === button));
  saveSettings();
}));
$("#clear-log").addEventListener("click", () => { state.log = []; renderLog(); });
$("#reset-settings").addEventListener("click", () => {
  state.settings = { version: 6, duration: 20, sensitivity: "medium", volume: 55, beepCount: 2, phone: true, objects: true, daze: true, continuous: false, keepAwake: true, boxes: true };
  saveSettings(); loadSettings(); toast("已恢复默认设置");
});

window.addEventListener("beforeunload", () => {
  stopStream();
  stopAllBeeps();
  releaseWakeLock();
  state.audioContext?.close();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.running && state.settings.keepAwake) requestWakeLock();
});
loadSettings();

if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch((error) => console.warn("Offline cache unavailable.", error)));
}
