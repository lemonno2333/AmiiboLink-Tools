const AMIIBO_LIST_JSON = "https://raw.githubusercontent.com/N3evin/AmiiboAPI/master/database/amiibo.json";
const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_TX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
const NUS_RX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
const BATTERY_SERVICE = "0000180f-0000-1000-8000-00805f9b34fb";
const DEVICE_INFO_SERVICE = "0000180a-0000-1000-8000-00805f9b34fb";
const SERIAL_NUMBER_CHARACTERISTIC = "00002a25-0000-1000-8000-00805f9b34fb";
const PROTOCOL_STORAGE_PREFIX = "amiibo-link-protocol:";
const EXPECTED_BIN_SIZE = 540;
const DEFAULT_FILE_HELP = "仅接受 .bin 文件，长度必须为 540 字节，且 NTAG215 UID 首字节须为 04。文件只在当前浏览器内存中处理，不会上传。";
const CHUNK_SIZE = 150;

const $ = (selector) => document.querySelector(selector);
const ui = {
  connect: $("#connect-button"), connectLabel: $("#connect-label"),
  deviceName: $("#device-name"), deviceDetail: $("#device-detail"), deviceLight: $("#device-light"),
  hardwareSerial: $("#hardware-serial"), copyHardwareSerial: $("#copy-hardware-serial"),
  modeStatus: $("#mode-status"), modeSelect: $("#mode-select"), applyMode: $("#apply-mode-button"),
  factoryMode: $("#factory-mode-button"), modeExplanation: $("#mode-explanation"),
  modeExplanationTitle: $("#mode-explanation-title"),
  modeExplanationCopy: $("#mode-explanation-copy"),
  protocol: $("#protocol-select"), fileInput: $("#file-input"), dropzone: $("#dropzone"),
  fileHelp: $("#file-help"),
  fileCard: $("#file-card"), fileName: $("#file-name"), fileSize: $("#file-size"),
  fileValidity: $("#file-validity"), clearFile: $("#clear-file"), binUrl: $("#bin-url"), loadUrl: $("#load-url"),
  transfer: $("#transfer-button"), transferStatus: $("#transfer-status"), transferLight: $("#transfer-light"),
  progress: $("#progress-fill"), catalogSearch: $("#catalog-search"), catalogStatus: $("#catalog-status"),
  catalogList: $("#catalog-list"), catalogDetail: $("#catalog-detail"), log: $("#log-list"), clearLog: $("#clear-log"),
  browserCompatibility: $("#browser-compatibility"), compatibilityTitle: $("#compatibility-title"),
  compatibilityDetail: $("#compatibility-detail"), browserWarningDialog: $("#browser-warning-dialog"),
  browserWarningDetail: $("#browser-warning-detail"), closeBrowserWarning: $("#close-browser-warning")
};

let browserBluetoothSupport = null;
let device = null;
let txCharacteristic = null;
let rxCharacteristic = null;
let activeProtocol = "kou";
let autoProtocolDetected = false;
let hardwareSerial = "";
let binBytes = null;
let binLabel = "";
let transferBusy = false;
let modeBusy = false;
let amiiboCatalog = [];
let selectedCatalogItem = null;
const packetQueue = [];
const packetWaiters = [];

function detectWebBluetoothSupport() {
  if (window.isSecureContext === false) return { supported: false, reason: "insecure" };
  if (!navigator.bluetooth || typeof navigator.bluetooth.requestDevice !== "function") {
    return { supported: false, reason: "unsupported" };
  }
  return { supported: true, reason: "supported" };
}

function updateBrowserCompatibility() {
  const status = browserBluetoothSupport;
  ui.browserCompatibility.classList.remove("is-checking", "is-supported", "is-unsupported");
  if (status.supported) {
    ui.browserCompatibility.classList.add("is-supported");
    ui.compatibilityTitle.textContent = "浏览器支持 Web Bluetooth";
    ui.compatibilityDetail.textContent = "浏览器已提供蓝牙连接接口；设备权限与可用性会在连接时确认。";
    return;
  }

  ui.browserCompatibility.classList.add("is-unsupported");
  if (status.reason === "insecure") {
    ui.compatibilityTitle.textContent = "当前页面不是安全上下文";
    ui.compatibilityDetail.textContent = "请通过 HTTPS 或 localhost 打开页面，再使用蓝牙连接。";
  } else {
    ui.compatibilityTitle.textContent = "此浏览器不支持 Web Bluetooth";
    ui.compatibilityDetail.textContent = "请改用最新版桌面 Chrome / Edge 或 Android Chrome。";
  }
}

function showBrowserWarning() {
  if (browserBluetoothSupport.supported) return;
  const explanation = browserBluetoothSupport.reason === "insecure"
    ? "Web Bluetooth 只能在安全上下文中使用。请通过 HTTPS 或 localhost 打开网页。"
    : "这个浏览器没有提供 Web Bluetooth API，无法连接 Amiibo Link。";
  ui.browserWarningDetail.textContent = `${explanation} 建议使用最新版桌面版 Chrome / Edge，或 Android Chrome。`;
  if (typeof ui.browserWarningDialog.showModal === "function") {
    ui.browserWarningDialog.showModal();
  } else {
    window.alert(`${ui.compatibilityTitle.textContent}\n\n${ui.browserWarningDetail.textContent}`);
  }
}

const MODE_DESCRIPTIONS = {
  infinite: {
    title: "无限模式（手动）",
    copy: "自动模式遇到游戏刷卡无响应时，小程序建议切换到此模式，重新写入数据并按下设备按钮即可解决。"
  },
  sequence: {
    title: "按序模式",
    copy: "将设备切换为按序模式。"
  },
  "read-write": {
    title: "读写模式",
    copy: "将设备切换为读写模式。小程序只在旧版协议中显示此选项。"
  },
  "infinite-auto": {
    title: "无限模式（自动）提示",
    copy: "该模式是实验性功能，目前还不十分稳定。有几率使用一段时间后，游戏里面刷卡就没有反应了。遇到这种情况，可以将模式设置为第一个【无限模式(手动)】，并重新写入数据，按下按钮，即可解决。"
  }
};

function addLog(message, kind = "") {
  const empty = ui.log.querySelector(".empty-log");
  if (empty) empty.remove();
  const row = document.createElement("div");
  row.className = `log-entry ${kind}`.trim();
  const time = document.createElement("time");
  time.textContent = new Intl.DateTimeFormat("zh-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());
  const text = document.createElement("span");
  text.textContent = message;
  row.append(time, text);
  ui.log.prepend(row);
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function setTransferState(message, state = "") {
  ui.transferStatus.textContent = message;
  ui.transferLight.className = `transfer-light${state ? ` is-${state}` : ""}`;
}

function refreshTransferButton() {
  ui.transfer.disabled = transferBusy || modeBusy || !device?.gatt?.connected || !binBytes || binBytes.length !== EXPECTED_BIN_SIZE;
}

function refreshModeActions() {
  const connected = Boolean(device?.gatt?.connected);
  const busy = transferBusy || modeBusy;
  const definitelyOldProtocol = ui.protocol.value === "kou" || (ui.protocol.value === "auto" && autoProtocolDetected && activeProtocol !== "kou2");
  const definitelyNewProtocol = ui.protocol.value === "kou2" || (ui.protocol.value === "auto" && autoProtocolDetected && activeProtocol === "kou2");
  const options = [...ui.modeSelect.options];
  options.forEach((option) => {
    if (!option.value) return;
    option.disabled = (option.dataset.newProtocol === "true" && definitelyOldProtocol) ||
      (option.dataset.oldProtocol === "true" && definitelyNewProtocol);
  });
  ui.modeSelect.disabled = !connected || busy;
  const selectedMode = ui.modeSelect.selectedOptions[0];
  ui.applyMode.disabled = !connected || busy || !ui.modeSelect.value || Boolean(selectedMode?.disabled);
  ui.factoryMode.disabled = !connected || busy || definitelyOldProtocol;
  updateModeExplanation();
}

function updateModeExplanation() {
  const selectedMode = ui.modeSelect.value;
  const mode = MODE_DESCRIPTIONS[selectedMode];
  ui.modeExplanation.classList.toggle("is-caution", selectedMode === "infinite" || selectedMode === "infinite-auto");
  if (!mode) {
    ui.modeExplanationTitle.textContent = "模式说明";
    ui.modeExplanationCopy.textContent = "选择模式后显示对应说明。";
    return;
  }
  ui.modeExplanationTitle.textContent = mode.title;
  const option = ui.modeSelect.selectedOptions[0];
  ui.modeExplanationCopy.textContent = option?.disabled ? `${mode.copy} 当前设备协议不支持此模式。` : mode.copy;
}

function setModeStatus(message, state = "") {
  ui.modeStatus.textContent = message;
  ui.modeStatus.classList.toggle("is-success", state === "success");
  ui.modeStatus.classList.toggle("is-error", state === "error");
}

function setHardwareSerial(serial) {
  hardwareSerial = serial || "";
  ui.hardwareSerial.textContent = hardwareSerial || "设备未提供可读取的硬件序列号";
  ui.copyHardwareSerial.disabled = !hardwareSerial;
}

function chooseProtocol(connectedDevice) {
  const selected = ui.protocol.value;
  if (selected !== "auto") return selected;
  return getSavedProtocol(connectedDevice) || "kou";
}

function getSavedProtocol(connectedDevice) {
  if (!connectedDevice?.id) return "";
  try {
    const saved = localStorage.getItem(`${PROTOCOL_STORAGE_PREFIX}${connectedDevice.id}`);
    return saved === "kou" || saved === "kou2" ? saved : "";
  } catch {
    return "";
  }
}

function rememberProtocol(protocol, source) {
  activeProtocol = protocol;
  autoProtocolDetected = true;
  if (device?.id) {
    try { localStorage.setItem(`${PROTOCOL_STORAGE_PREFIX}${device.id}`, protocol); } catch { /* Storage can be disabled. */ }
  }
  if (ui.protocol.value === "auto") {
    ui.deviceDetail.textContent = `已连接 · 自动识别为${protocol === "kou2" ? "新版加密协议" : "旧版直传协议"}`;
    addLog(`自动识别为${protocol === "kou2" ? "新版加密协议" : "旧版直传协议"}${source ? `（${source}）` : ""}。`, "is-success");
  }
  refreshModeActions();
}

function protocolDetail() {
  if (ui.protocol.value === "auto" && !autoProtocolDetected) return "已连接 · 自动识别待握手";
  return `已连接 · ${activeProtocol === "kou2" ? "新版加密协议" : "旧版直传协议"}`;
}

function normalizeUuid(uuid) {
  return String(uuid || "").toLowerCase().replace(/-/g, "");
}

async function detectAdvertisedProtocol(connectedDevice, timeoutMs = 1600) {
  if (typeof connectedDevice?.watchAdvertisements !== "function") return "";
  const controller = new AbortController();
  let listener;
  let timer;
  try {
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (protocol) => {
        if (settled) return;
        settled = true;
        if (listener) connectedDevice.removeEventListener("advertisementreceived", listener);
        clearTimeout(timer);
        controller.abort();
        resolve(protocol || "");
      };
      listener = (event) => {
        const uuids = [...(event.uuids || [])].map(normalizeUuid);
        if (!uuids.length) return;
        // The mini-program treats the advertised Battery Service (0x180F) as the new protocol marker.
        finish(uuids.includes("0000180f00001000800000805f9b34fb") || uuids.includes("180f") ? "kou2" : "kou");
      };
      connectedDevice.addEventListener("advertisementreceived", listener);
      timer = setTimeout(() => finish(""), timeoutMs);
      connectedDevice.watchAdvertisements({ signal: controller.signal }).catch(() => finish(""));
    });
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
    if (listener) connectedDevice.removeEventListener("advertisementreceived", listener);
    controller.abort();
  }
}

async function readHardwareSerial(server) {
  try {
    const service = await server.getPrimaryService(DEVICE_INFO_SERVICE);
    const characteristic = await service.getCharacteristic(SERIAL_NUMBER_CHARACTERISTIC);
    const value = await characteristic.readValue();
    return new TextDecoder().decode(value).replace(/\0/g, "").trim();
  } catch {
    return "";
  }
}

function setDeviceState(name, detail, connected) {
  ui.deviceName.textContent = name;
  ui.deviceDetail.textContent = detail;
  ui.deviceLight.classList.toggle("is-connected", connected);
  ui.connectLabel.textContent = connected ? "断开设备" : "连接设备";
  refreshTransferButton();
  refreshModeActions();
}

function onDisconnected() {
  txCharacteristic = null;
  rxCharacteristic = null;
  setDeviceState("尚未连接", "设备已断开；可重新连接", false);
  if (!modeBusy) setModeStatus("设备已断开，请重新连接后操作。");
  addLog("蓝牙连接已断开");
}

function enqueuePacket(packet) {
  const waiter = packetWaiters.shift();
  if (waiter) {
    clearTimeout(waiter.timer);
    waiter.resolve(packet);
  } else {
    packetQueue.push(packet);
  }
}

function looksLikeKou2Frame(raw) {
  if (raw.length < 4) return false;
  const encryptedLength = raw[2];
  const plainLength = raw[3];
  return encryptedLength > 0 && encryptedLength % 16 === 0 &&
    plainLength > 0 && plainLength <= encryptedLength &&
    raw.length >= 4 + encryptedLength;
}

function waitForPacket(timeoutMs = 7000) {
  if (packetQueue.length) return { promise: Promise.resolve(packetQueue.shift()), cancel() {} };
  let waiter;
  const promise = new Promise((resolve, reject) => {
    waiter = { resolve, reject, timer: setTimeout(() => {
      const index = packetWaiters.indexOf(waiter);
      if (index >= 0) packetWaiters.splice(index, 1);
      reject(new Error("等待设备响应超时，请确认设备仍处于蓝牙传输模式。"));
    }, timeoutMs) };
    packetWaiters.push(waiter);
  });
  return { promise, cancel() {
    const index = packetWaiters.indexOf(waiter);
    if (index >= 0) packetWaiters.splice(index, 1);
    clearTimeout(waiter?.timer);
  } };
}

async function aesEcbBlocks(input, keyBytes, operation) {
  if (!crypto?.subtle) throw new Error("当前浏览器没有可用的 Web Crypto，无法使用新版加密协议。");
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);
  const output = new Uint8Array(input.length);
  const zeroIv = new Uint8Array(16);
  async function encryptBlock(block) {
    const encrypted = await crypto.subtle.encrypt({ name: "AES-CBC", iv: zeroIv }, key, block);
    return new Uint8Array(encrypted).slice(0, 16);
  }
  // Web Crypto pads CBC with PKCS#7. Encrypt's first block is ECB; for decrypt, append a constructed full padding block.
  for (let offset = 0; offset < input.length; offset += 16) {
    const block = input.slice(offset, offset + 16);
    if (operation === "encrypt") {
      output.set(await encryptBlock(block), offset);
    } else {
      const padded = new Uint8Array(16).fill(16);
      for (let index = 0; index < 16; index += 1) padded[index] ^= block[index];
      const paddingCipher = await encryptBlock(padded);
      const pair = new Uint8Array(32);
      pair.set(block, 0);
      pair.set(paddingCipher, 16);
      const decrypted = await crypto.subtle.decrypt({ name: "AES-CBC", iv: zeroIv }, key, pair);
      output.set(new Uint8Array(decrypted).slice(0, 16), offset);
    }
  }
  return output;
}

function makeAesKey(randomA, randomB) {
  return new Uint8Array([0x4b, 0x47, 0x46, 0x5f, 0x41, 0x4d, 0x49, 0x4c, 0x07, 0xe7, 0x04, 0x06, 0x0a, 0x2a, randomA, randomB]);
}

async function wrapKou2(plain) {
  const random = new Uint8Array(2);
  crypto.getRandomValues(random);
  const randomA = random[0] % 101;
  const randomB = random[1] % 101;
  const paddedLength = Math.ceil(plain.length / 16) * 16;
  const padded = new Uint8Array(paddedLength);
  padded.set(plain);
  const encrypted = await aesEcbBlocks(padded, makeAesKey(randomA, randomB), "encrypt");
  if (encrypted.length > 255 || plain.length > 255) throw new Error("协议数据包过长。");
  const frame = new Uint8Array(4 + encrypted.length);
  frame.set([randomA, randomB, encrypted.length, plain.length]);
  frame.set(encrypted, 4);
  return frame;
}

async function unwrapKou2(frame) {
  if (frame.length < 4) throw new Error("新版协议响应头不完整。");
  const encryptedLength = frame[2];
  const plainLength = frame[3];
  if (encryptedLength % 16 !== 0 || frame.length < 4 + encryptedLength) throw new Error("新版协议响应长度无效。");
  const key = makeAesKey(frame[0], frame[1]);
  const decrypted = await aesEcbBlocks(frame.slice(4, 4 + encryptedLength), key, "decrypt");
  return decrypted.slice(0, plainLength);
}

async function handleNotification(event) {
  const view = event.target.value;
  const raw = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
  try {
    if (ui.protocol.value === "auto" && activeProtocol !== "kou2" && looksLikeKou2Frame(raw)) {
      rememberProtocol("kou2", "加密响应帧");
    }
    const packet = activeProtocol === "kou2" ? await unwrapKou2(raw) : raw;
    enqueuePacket(packet);
  } catch (error) {
    addLog(`解析设备响应失败：${error.message}`, "is-error");
  }
}

async function writePacket(plain) {
  if (!txCharacteristic) throw new Error("设备写入特征不可用，请重新连接。");
  const data = activeProtocol === "kou2" ? await wrapKou2(plain) : plain;
  if (txCharacteristic.properties.write) await txCharacteristic.writeValueWithResponse(data);
  else await txCharacteristic.writeValueWithoutResponse(data);
}

async function exchange(bytes, expectedPrefix, stepName) {
  const pending = waitForPacket();
  try {
    await writePacket(bytes);
    const response = await pending.promise;
    if (expectedPrefix && (response.length < expectedPrefix.length || expectedPrefix.some((value, index) => response[index] !== value))) {
      throw new Error(`${stepName}响应不匹配：${bytesToHex(response.slice(0, 8)) || "空响应"}`);
    }
    if (ui.protocol.value === "auto" && !autoProtocolDetected && activeProtocol === "kou") {
      rememberProtocol("kou", `${stepName}响应`);
    }
    return response;
  } catch (error) {
    pending.cancel();
    throw error;
  }
}

async function connectDevice() {
  if (!browserBluetoothSupport?.supported) {
    throw new Error("当前浏览器环境无法使用 Web Bluetooth。请使用支持的浏览器，并通过 HTTPS 或 localhost 打开页面。");
  }
  if (device?.gatt?.connected) {
    device.gatt.disconnect();
    return;
  }
  ui.connect.disabled = true;
  try {
    const namePrefixes = ["amiibolink", "AmiiboLink", "Amiibo Link", "AMIIBO LINK"];
    const picked = await navigator.bluetooth.requestDevice({
      filters: namePrefixes.map((namePrefix) => ({ namePrefix })),
      optionalServices: [NUS_SERVICE, BATTERY_SERVICE, DEVICE_INFO_SERVICE]
    });
    device = picked;
    setHardwareSerial("");
    device.addEventListener("gattserverdisconnected", onDisconnected);
    const savedProtocol = ui.protocol.value === "auto" ? getSavedProtocol(picked) : "";
    const advertisedProtocol = ui.protocol.value === "auto" ? await detectAdvertisedProtocol(picked) : "";
    activeProtocol = ui.protocol.value === "auto" ? advertisedProtocol || savedProtocol || "kou" : ui.protocol.value;
    autoProtocolDetected = ui.protocol.value !== "auto" || Boolean(advertisedProtocol || savedProtocol);
    if (ui.protocol.value === "auto" && advertisedProtocol) rememberProtocol(advertisedProtocol, "广播服务");
    const server = await picked.gatt.connect();
    const service = await server.getPrimaryService(NUS_SERVICE);
    const characteristics = await service.getCharacteristics();
    txCharacteristic = characteristics.find((item) => item.uuid.toLowerCase() === NUS_TX) || characteristics.find((item) => item.properties.write || item.properties.writeWithoutResponse);
    rxCharacteristic = characteristics.find((item) => item.uuid.toLowerCase() === NUS_RX) || characteristics.find((item) => item.properties.notify || item.properties.indicate);
    if (!txCharacteristic || !rxCharacteristic) throw new Error("找不到可写入和通知的 BLE 特征。");
    rxCharacteristic.addEventListener("characteristicvaluechanged", handleNotification);
    await rxCharacteristic.startNotifications();
    setHardwareSerial(await readHardwareSerial(server));
    setDeviceState(picked.name || "Amiibo Link", protocolDetail(), true);
    setModeStatus("已连接；选择模式后设备会断开，重新连接即可继续操作。");
    addLog(`已连接 ${picked.name || "BLE 设备"}，${protocolDetail().replace("已连接 · ", "协议：")}`, "is-success");
  } catch (error) {
    if (device?.gatt?.connected) device.gatt.disconnect();
    setHardwareSerial("");
    if (error.name !== "NotFoundError") addLog(`连接失败：${error.message}`, "is-error");
    setDeviceState("尚未连接", error.name === "NotFoundError" ? "已取消设备选择" : error.message, false);
    setModeStatus("请先连接设备。");
  } finally {
    ui.connect.disabled = false;
    refreshTransferButton();
  }
}

function updateProtocol() {
  if (!device?.gatt?.connected || transferBusy) return;
  activeProtocol = chooseProtocol(device);
  autoProtocolDetected = ui.protocol.value !== "auto" || Boolean(getSavedProtocol(device));
  ui.deviceDetail.textContent = protocolDetail();
  refreshModeActions();
}

async function copyHardwareSerial() {
  if (!hardwareSerial) return;
  try {
    await navigator.clipboard.writeText(hardwareSerial);
    addLog("已复制硬件序列号。", "is-success");
  } catch {
    addLog("复制硬件序列号失败；请确认浏览器允许访问剪贴板。", "is-error");
  }
}

function isBinFileName(fileName) {
  return /\.bin$/i.test(fileName);
}

function validateAmiiboBin(fileName, bytes) {
  if (!isBinFileName(fileName)) return "只接受扩展名为 .bin 的文件。";
  if (bytes.length !== EXPECTED_BIN_SIZE) return `BIN 文件应为 ${EXPECTED_BIN_SIZE} 字节，当前为 ${bytes.length} 字节。`;
  if (bytes[0] !== 0x04) return "文件不符合 NTAG215 UID 格式（UID 首字节应为 04），已拒绝导入。";
  return "";
}

function rejectBin(message) {
  clearBin();
  ui.fileHelp.textContent = message;
  setTransferState("文件未通过格式校验");
  addLog(message, "is-error");
}

function setBin(fileName, bytes) {
  const validationError = validateAmiiboBin(fileName, bytes);
  if (validationError) {
    rejectBin(validationError);
    return false;
  }
  binLabel = fileName;
  binBytes = bytes;
  ui.fileHelp.textContent = DEFAULT_FILE_HELP;
  ui.fileCard.hidden = false;
  ui.fileName.textContent = fileName;
  ui.fileSize.textContent = `${bytes.length} bytes`;
  ui.fileValidity.textContent = "540 B · 可传输";
  ui.fileValidity.classList.remove("is-invalid");
  ui.dropzone.querySelector(".dropzone-title").textContent = fileName;
  ui.dropzone.querySelector(".dropzone-subtitle").textContent = "文件已载入，可以传到设备";
  setTransferState("BIN 已就绪");
  ui.progress.style.width = "0%";
  refreshTransferButton();
  addLog(`已载入 ${fileName}（540 bytes）`, "is-success");
  return true;
}

function clearBin() {
  binBytes = null;
  binLabel = "";
  ui.fileInput.value = "";
  ui.fileHelp.textContent = DEFAULT_FILE_HELP;
  ui.fileCard.hidden = true;
  ui.dropzone.querySelector(".dropzone-title").textContent = "选择本机 BIN 文件";
  ui.dropzone.querySelector(".dropzone-subtitle").textContent = "也可以把文件拖到这里";
  ui.progress.style.width = "0%";
  setTransferState("等待 BIN 文件");
  refreshTransferButton();
}

async function readFile(file) {
  if (!file) return;
  if (!isBinFileName(file.name)) {
    rejectBin("只接受扩展名为 .bin 的文件。其他格式不会放入文件框或传到设备。");
    return;
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  setBin(file.name, bytes);
}

async function loadBinFromUrl() {
  const rawUrl = ui.binUrl.value.trim();
  if (!rawUrl) {
    addLog("先输入一个你有权使用的 BIN 直链。", "is-error");
    return;
  }
  let url;
  try { url = new URL(rawUrl); } catch { addLog("BIN 链接格式无效。", "is-error"); return; }
  if (url.protocol !== "https:") {
    addLog("为保护本机连接，只接受 HTTPS 文件链接。", "is-error");
    return;
  }
  let fileName;
  try { fileName = decodeURIComponent(url.pathname.split("/").pop() || ""); }
  catch { fileName = ""; }
  if (!isBinFileName(fileName)) {
    rejectBin("直链路径必须以 .bin 结尾；其他格式不会读取或传到设备。");
    return;
  }
  ui.loadUrl.disabled = true;
  ui.loadUrl.textContent = "读取中";
  try {
    const response = await fetch(url, { mode: "cors", credentials: "omit" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    setBin(fileName, bytes);
  } catch (error) {
    addLog(`读取链接失败：${error.message}。来源站可能不允许跨站读取；可先在浏览器下载，再选择本机文件。`, "is-error");
  } finally {
    ui.loadUrl.disabled = false;
    ui.loadUrl.textContent = "读取";
  }
}

async function transferBin() {
  if (!binBytes || binBytes.length !== EXPECTED_BIN_SIZE || !device?.gatt?.connected || transferBusy) return;
  transferBusy = true;
  activeProtocol = chooseProtocol(device);
  packetQueue.length = 0;
  ui.protocol.disabled = true;
  refreshModeActions();
  ui.transfer.textContent = "正在传输…";
  ui.progress.style.width = "0%";
  setTransferState("正在准备设备", "active");
  addLog(`开始传输 ${binLabel}，协议 ${activeProtocol}`, "");
  try {
    await exchange(new Uint8Array([0xa0, 0xb0]), [0xb0, 0xa0], "准备写入");
    await exchange(new Uint8Array([0xac, 0xac, 0x00, 0x04, 0x00, 0x00, 0x02, 0x1c]), [0xca, 0xca], "确认数据长度");
    await exchange(new Uint8Array([0xab, 0xab, 0x02, 0x1c]), [0xba, 0xba], "准备分块传输");

    let sent = 0;
    let sequence = 0;
    while (sent < binBytes.length) {
      const chunk = binBytes.slice(sent, sent + CHUNK_SIZE);
      const frame = new Uint8Array(6 + chunk.length);
      frame.set([0xdd, 0xaa, 0x00, chunk.length], 0);
      frame.set(chunk, 4);
      frame[frame.length - 2] = (sequence >> 8) & 0xff;
      frame[frame.length - 1] = sequence & 0xff;
      await exchange(frame, [0xaa, 0xdd], `传输分块 ${sequence + 1}`);
      sent += chunk.length;
      sequence += 1;
      ui.progress.style.width = `${Math.round((sent / binBytes.length) * 100)}%`;
      setTransferState(`已传输 ${sent} / ${binBytes.length} bytes`, "active");
    }

    await exchange(new Uint8Array([0xbc, 0xbc]), [0xcb, 0xcb], "结束数据传输");
    await exchange(new Uint8Array([0xcc, 0xdd]), [0xdd, 0xcc], "确认写入完成");
    ui.progress.style.width = "100%";
    setTransferState("写入完成", "done");
    addLog(`${binLabel} 已写入设备。`, "is-success");
  } catch (error) {
    setTransferState("传输未完成，请重新连接后重试");
    addLog(`传输失败：${error.message}`, "is-error");
  } finally {
    transferBusy = false;
    ui.protocol.disabled = false;
    ui.transfer.textContent = "传到设备 →";
    refreshTransferButton();
    refreshModeActions();
  }
}

async function setDeviceMode(mode) {
  const modes = {
    infinite: { label: "无限模式（手动）", command: [0xa1, 0xb1, 0x01], response: [0xb1, 0xa1] },
    sequence: { label: "按序模式", command: [0xa1, 0xb1, 0x02], response: [0xb1, 0xa1] },
    "read-write": { label: "读写模式", command: [0xa1, 0xb1, 0x03], response: [0xb1, 0xa1] },
    "infinite-auto": { label: "无限模式（自动）", command: [0xa1, 0xb1, 0x04], response: [0xb1, 0xa1], newProtocolOnly: true },
    factory: { label: "恢复出厂设置", command: [0xa3, 0xb3], response: [0xa3, 0xb3], newProtocolOnly: true }
  };
  const action = modes[mode];
  if (!action || !device?.gatt?.connected || transferBusy || modeBusy) return;
  if (mode === "factory" && !window.confirm("确认向设备发送“恢复出厂设置”指令吗？")) return;

  modeBusy = true;
  packetQueue.length = 0;
  ui.protocol.disabled = true;
  refreshTransferButton();
  refreshModeActions();
  setModeStatus(`正在设置${action.label}…`);
  try {
    if (action.newProtocolOnly && activeProtocol !== "kou2" && ui.protocol.value === "auto" && !autoProtocolDetected) {
      await exchange(new Uint8Array([0xa0, 0xb0]), [0xb0, 0xa0], "协议识别握手");
    }
    if (action.newProtocolOnly && activeProtocol !== "kou2") {
      throw new Error(`${action.label}仅支持新版加密协议；请确认设备固件版本或在协议选项中手动选择新版。`);
    }
    await exchange(new Uint8Array(action.command), action.response, action.label);
    const message = mode === "factory"
      ? "恢复出厂设置已确认；设备连接已关闭。"
      : `已切换到${action.label}；设备连接已关闭。`;
    setModeStatus(message, "success");
    addLog(message, "is-success");
    device.gatt.disconnect();
  } catch (error) {
    setModeStatus(`${action.label}失败：${error.message}`, "error");
    addLog(`${action.label}失败：${error.message}`, "is-error");
  } finally {
    modeBusy = false;
    ui.protocol.disabled = false;
    refreshTransferButton();
    refreshModeActions();
  }
}

function setTab(tabName) {
  document.querySelectorAll(".source-tab").forEach((tab) => {
    const active = tab.dataset.tab === tabName;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  $("#file-tab").hidden = tabName !== "file";
  $("#catalog-tab").hidden = tabName !== "catalog";
}

function renderCatalog() {
  const query = ui.catalogSearch.value.trim().toLocaleLowerCase();
  const matches = amiiboCatalog.filter((item) => `${item.name || ""} ${item.character || ""} ${item.gameSeries || ""} ${item.amiiboSeries || ""}`.toLocaleLowerCase().includes(query)).slice(0, 32);
  ui.catalogList.replaceChildren();
  if (!matches.length) {
    const empty = document.createElement("p");
    empty.className = "field-note";
    empty.textContent = amiiboCatalog.length ? "没有匹配的 Amiibo。" : "公开目录尚未载入。";
    ui.catalogList.append(empty);
    return;
  }
  for (const item of matches) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `catalog-item${selectedCatalogItem === item ? " is-selected" : ""}`;
    const image = item.image ? document.createElement("img") : document.createElement("span");
    if (item.image) {
      image.src = item.image;
      image.alt = "";
      image.loading = "lazy";
      image.onerror = () => { image.replaceWith(makePlaceholder()); };
    } else {
      image.className = "catalog-placeholder";
      image.textContent = "NFC";
    }
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = item.name || item.character || "未命名 Amiibo";
    const ids = document.createElement("small");
    ids.textContent = `${item.head || "--------"} ${item.tail || "--------"}`;
    copy.append(name, ids);
    const series = document.createElement("span");
    series.className = "catalog-game";
    series.textContent = item.amiiboSeries || item.gameSeries || "";
    button.append(image, copy, series);
    button.addEventListener("click", () => selectCatalogItem(item));
    ui.catalogList.append(button);
  }
  ui.catalogStatus.textContent = `${amiiboCatalog.length.toLocaleString()} 条目录记录 · 显示 ${matches.length} 条`;
}

function makePlaceholder() {
  const placeholder = document.createElement("span");
  placeholder.className = "catalog-placeholder";
  placeholder.textContent = "NFC";
  return placeholder;
}

function selectCatalogItem(item) {
  selectedCatalogItem = item;
  ui.catalogDetail.hidden = false;
  ui.catalogDetail.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = `${item.name || item.character || "Amiibo"} · ${item.amiiboSeries || item.gameSeries || ""}`;
  const note = document.createElement("p");
  note.textContent = `识别 ID：${item.head || "--------"} ${item.tail || "--------"}。这是公开目录元数据，不是可写入设备的 BIN 文件。`;
  ui.catalogDetail.append(title, note);
  renderCatalog();
}

async function loadCatalog() {
  ui.catalogStatus.textContent = "正在读取公开 Amiibo ID JSON…";
  try {
    const response = await fetch(AMIIBO_LIST_JSON, { headers: { Accept: "application/json" }, credentials: "omit" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!body.amiibos || typeof body.amiibos !== "object") throw new Error("JSON 返回的数据格式不符合预期");
    amiiboCatalog = Object.entries(body.amiibos).map(([rawId, entry]) => {
      const id = rawId.replace(/^0x/i, "").toLowerCase();
      return {
        name: entry.name,
        head: id.slice(0, 8),
        tail: id.slice(8, 16),
        id: rawId
      };
    });
    ui.catalogStatus.textContent = `${amiiboCatalog.length.toLocaleString()} 条目录记录已载入`;
    renderCatalog();
    addLog(`已从 AmiiboAPI 公开 JSON 载入 ${amiiboCatalog.length.toLocaleString()} 条 Amiibo ID 记录。`, "is-success");
  } catch (error) {
    ui.catalogStatus.textContent = `目录读取失败：${error.message}`;
    ui.catalogList.replaceChildren();
    addLog(`公开目录读取失败：${error.message}`, "is-error");
  }
}

ui.connect.addEventListener("click", connectDevice);
ui.closeBrowserWarning.addEventListener("click", () => {
  if (typeof ui.browserWarningDialog.close === "function") ui.browserWarningDialog.close();
});
ui.protocol.addEventListener("change", updateProtocol);
ui.copyHardwareSerial.addEventListener("click", copyHardwareSerial);
ui.modeSelect.addEventListener("change", refreshModeActions);
ui.applyMode.addEventListener("click", () => setDeviceMode(ui.modeSelect.value));
ui.factoryMode.addEventListener("click", () => setDeviceMode("factory"));
ui.dropzone.addEventListener("click", () => ui.fileInput.click());
ui.fileInput.addEventListener("change", (event) => readFile(event.target.files?.[0]));
ui.clearFile.addEventListener("click", clearBin);
ui.loadUrl.addEventListener("click", loadBinFromUrl);
ui.binUrl.addEventListener("keydown", (event) => { if (event.key === "Enter") loadBinFromUrl(); });
ui.transfer.addEventListener("click", transferBin);
ui.catalogSearch.addEventListener("input", renderCatalog);
ui.clearLog.addEventListener("click", () => {
  ui.log.innerHTML = '<p class="empty-log">连接状态、目录读取和传输结果会显示在这里。</p>';
});
document.querySelectorAll(".source-tab").forEach((tab) => tab.addEventListener("click", () => setTab(tab.dataset.tab)));

for (const eventName of ["dragenter", "dragover"]) {
  ui.dropzone.addEventListener(eventName, (event) => { event.preventDefault(); ui.dropzone.classList.add("is-dragging"); });
}
for (const eventName of ["dragleave", "drop"]) {
  ui.dropzone.addEventListener(eventName, (event) => { event.preventDefault(); ui.dropzone.classList.remove("is-dragging"); });
}
ui.dropzone.addEventListener("drop", (event) => readFile(event.dataTransfer?.files?.[0]));

browserBluetoothSupport = detectWebBluetoothSupport();
updateBrowserCompatibility();
if (!browserBluetoothSupport.supported) {
  setDeviceState("浏览器无法连接蓝牙", ui.compatibilityDetail.textContent, false);
  ui.connect.disabled = true;
  showBrowserWarning();
}
loadCatalog();
