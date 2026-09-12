/* ══════════════════════════════════════════════════════════════
   JARVIS WEB UI — Client Logic
   WebSocket chat + Web Speech API voice + HUD state machine
   ══════════════════════════════════════════════════════════════ */

'use strict';

// ── State machine ─────────────────────────────────────────────
const STATE = { IDLE: 'idle', LISTENING: 'listening', THINKING: 'thinking', SPEAKING: 'speaking' };

let currentState = STATE.IDLE;
let ws           = null;
let recognition  = null;
let speaking     = false;
let autoListenActive = false; // VOICE DISABLED — text-only mode

// ── DOM refs ──────────────────────────────────────────────────
const orbWrap       = document.getElementById('orb-wrap');
const stateReadout  = document.getElementById('state-readout');
const stateSublabel = document.getElementById('state-sublabel');
const conversation  = document.getElementById('conversation');
const textInput     = document.getElementById('text-input');
const sendBtn       = document.getElementById('send-btn');
const micBtn        = document.getElementById('mic-btn');
const clearBtn      = document.getElementById('clear-btn');
const statusDot     = document.getElementById('status-dot');
const statusLabel   = document.getElementById('status-label');
const autonomousToggle = document.getElementById('autonomous-toggle');
const toggleWrap    = document.querySelector('.autonomous-toggle-wrap');
const toggleLabel   = document.getElementById('toggle-label');

// ── Model Provider DOM refs & state ───────────────────────────
const providerSelect      = document.getElementById('provider-select');
const secondaryControls   = document.getElementById('secondary-controls');
const secOllama           = document.getElementById('secondary-ollama');
const ollamaModelSelect   = document.getElementById('ollama-model-select');
const refreshOllamaBtn    = document.getElementById('refresh-ollama-btn');
const secLMStudio         = document.getElementById('secondary-lmstudio');
const lmstudioModelSelect = document.getElementById('lmstudio-model-select');
const refreshLMStudioBtn  = document.getElementById('refresh-lmstudio-btn');
const secApiKey           = document.getElementById('secondary-api-key');
const apiKeyInput         = document.getElementById('api-key-input');
const toggleKeyVisBtn     = document.getElementById('toggle-key-visibility');
const verifyKeyBtn        = document.getElementById('verify-key-btn');
const keyStatusIndicator  = document.getElementById('key-status-indicator');
const secCustomUrl        = document.getElementById('secondary-custom-url');
const customUrlInput      = document.getElementById('custom-url-input');
const applyCustomUrlBtn   = document.getElementById('apply-custom-url-btn');
const modelNameDisplay    = document.getElementById('model-name');
const modelStatusDot      = document.getElementById('model-status-dot');

const MODEL_STORAGE_KEY = 'jarvis_model_provider_config';

function getStoredModelConfig() {
  try {
    const raw = localStorage.getItem(MODEL_STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {
    provider: 'ollama',
    ollamaModel: 'llava:latest',
    lmstudioModel: 'local-model',
    apiKey: '',
    apiModel: 'gemini-3.6-flash',
    customUrl: 'http://localhost:8000/v1',
  };
}

function saveStoredModelConfig(conf) {
  try {
    localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(conf));
  } catch {}
}

let providerConfig = getStoredModelConfig();

// ── State transitions ─────────────────────────────────────────
const STATE_META = {
  idle:      { label: 'IDLE',       sub: 'Awaiting input...',        orbClass: '' },
  listening: { label: 'LISTENING',  sub: 'Speak now...',             orbClass: 'state-listening' },
  thinking:  { label: 'PROCESSING', sub: 'Jarvis is thinking...',    orbClass: 'state-thinking' },
  speaking:  { label: 'RESPONDING', sub: 'Jarvis is responding...', orbClass: 'state-speaking' },
};

function setState(newState) {
  if (currentState === newState) return;
  currentState = newState;
  const meta = STATE_META[newState];

  stateReadout.textContent  = meta.label;
  stateSublabel.textContent = meta.sub;

  orbWrap.className = 'orb-wrap ' + meta.orbClass;

  sendBtn.disabled  = newState === STATE.THINKING;
  textInput.disabled = newState === STATE.THINKING;
}

// ── WebSocket connection ──────────────────────────────────────
function connectWS() {
  const url = `ws://${location.host}`;
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    statusDot.className   = 'status-dot online';
    statusLabel.textContent = 'ONLINE';
    statusLabel.className   = 'status-label online';
    setState(STATE.IDLE);
    stateSublabel.textContent = 'Jarvis online. Click anywhere to activate voice control.';

    // Push client's stored/selected runtime provider config to server immediately on connect
    dispatchProviderChange();
  });

  ws.addEventListener('close', () => {
    statusDot.className     = 'status-dot offline';
    statusLabel.textContent = 'OFFLINE';
    statusLabel.className   = 'status-label offline';
    stateReadout.textContent  = 'DISCONNECTED';
    stateSublabel.textContent = 'Reconnecting in 3s...';
    setTimeout(connectWS, 3000);
  });

  ws.addEventListener('error', () => ws.close());

  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === 'state') {
      setState(msg.state);

    } else if (msg.type === 'reply') {
      removeThinkingIndicator();
      appendMessage('jarvis', msg.text);
      setState(STATE.SPEAKING);
      speakText(msg.text);

    } else if (msg.type === 'mode_ack') {
      if (autonomousToggle) {
        autonomousToggle.checked = Boolean(msg.autonomous);
        if (toggleWrap) toggleWrap.classList.toggle('active', msg.autonomous);
        if (toggleLabel) toggleLabel.textContent = msg.autonomous ? 'AUTO OVERRIDE [ON]' : 'AUTO OVERRIDE';
      }
      if (!msg.success && msg.error) {
        appendMessage('error', `Core daemon mode sync error: ${msg.error}`);
      }

    } else if (msg.type === 'provider_ack') {
      if (msg.provider) {
        providerConfig.provider = msg.provider;
        if (providerSelect && providerSelect.value !== msg.provider) {
          providerSelect.value = msg.provider;
        }
        if (msg.model) {
          if (msg.provider === 'ollama') providerConfig.ollamaModel = msg.model;
          if (msg.provider === 'lmstudio') providerConfig.lmstudioModel = msg.model;
          if (msg.provider === 'api_key') providerConfig.apiModel = msg.model;
        }
        updateSecondaryVisibility(msg.provider);
        updateActiveModelBadge();
      }

    } else if (msg.type === 'system' || msg.type === 'progress') {
      appendMessage('system', msg.text);

    } else if (msg.type === 'error') {
      removeThinkingIndicator();
      appendMessage('error', msg.text || 'Unknown error');
      setState(STATE.IDLE);
    }
  });
}

function sendMessage(text) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!text.trim()) return;

  appendMessage('user', text);
  showThinkingIndicator();
  setState(STATE.THINKING);
  ws.send(JSON.stringify({ type: 'message', text }));
}

// ── Message rendering ─────────────────────────────────────────
function appendMessage(role, text) {
  const div = document.createElement('div');

  const labelMap = {
    jarvis: 'JARVIS',
    user:   'YOU',
    system: 'SYS',
    error:  'ERR',
  };

  div.className = `msg msg-${role}`;
  div.innerHTML = `
    <span class="msg-label">${labelMap[role] || role.toUpperCase()}</span>
    <span class="msg-text"></span>
  `;

  conversation.appendChild(div);
  conversation.scrollTop = conversation.scrollHeight;

  const textSpan = div.querySelector('.msg-text');

  if (role === 'jarvis') {
    typewrite(textSpan, text);
  } else {
    textSpan.textContent = text;
  }
}

let thinkingEl = null;

function showThinkingIndicator() {
  removeThinkingIndicator();
  thinkingEl = document.createElement('div');
  thinkingEl.className = 'msg msg-jarvis';
  thinkingEl.innerHTML = `
    <span class="msg-label">JARVIS</span>
    <span class="msg-text thinking-dots">
      <span></span><span></span><span></span>
    </span>
  `;
  conversation.appendChild(thinkingEl);
  conversation.scrollTop = conversation.scrollHeight;
}

function removeThinkingIndicator() {
  if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
}

// Typewriter effect for Jarvis responses
function typewrite(el, text, speed = 18) {
  el.textContent = '';
  el.classList.add('typewriter');
  let i = 0;
  const interval = setInterval(() => {
    el.textContent += text[i] ?? '';
    i++;
    if (i >= text.length) {
      clearInterval(interval);
      el.classList.remove('typewriter');
      setState(STATE.IDLE);
    }
    conversation.scrollTop = conversation.scrollHeight;
  }, speed);
}

// ── Text-to-speech — DISABLED (text-only mode) ──────────────
function speakText(_text) {
  // Voice output disabled — Jarvis responds via text only
  setState(STATE.IDLE);
}

// ── Voice input (Web Speech API) ─────────────────────────────
function initSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    micBtn.title   = 'Voice input not supported in this browser';
    micBtn.style.opacity = '0.4';
    micBtn.style.cursor  = 'not-allowed';
    return;
  }

  recognition = new SR();
  recognition.continuous     = false;
  recognition.interimResults = true;
  recognition.lang           = 'en-US';

  recognition.addEventListener('start', () => {
    setState(STATE.LISTENING);
    micBtn.classList.add('listening');
  });

  recognition.addEventListener('result', (ev) => {
    const last    = ev.results[ev.results.length - 1];
    const interim = last[0].transcript;
    textInput.value = interim;
    if (last.isFinal) {
      const final = interim.trim();
      textInput.value = '';
      if (final) sendMessage(final);
    }
  });

  recognition.addEventListener('end', () => {
    micBtn.classList.remove('listening');
    if (currentState === STATE.LISTENING) setState(STATE.IDLE);
    if (autoListenActive && currentState === STATE.IDLE) {
      setTimeout(() => {
        try { recognition.start(); } catch {}
      }, 400);
    }
  });

  recognition.addEventListener('error', (ev) => {
    micBtn.classList.remove('listening');
    setState(STATE.IDLE);
    if (ev.error === 'not-allowed') {
      stateSublabel.textContent = 'Microphone blocked. Please allow mic access in your browser address bar.';
      appendMessage('error', 'Microphone access blocked. Click the lock icon in your address bar to allow.');
      return;
    }
    if (ev.error !== 'aborted' && ev.error !== 'no-speech') {
      appendMessage('error', `Mic error: ${ev.error}`);
    }
    if (autoListenActive && currentState === STATE.IDLE) {
      setTimeout(() => {
        try { recognition.start(); } catch {}
      }, 1000);
    }
  });
}

// ── Event listeners ───────────────────────────────────────────
sendBtn.addEventListener('click', () => {
  const t = textInput.value.trim();
  if (!t) return;
  textInput.value = '';
  sendMessage(t);
});

textInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    const t = textInput.value.trim();
    if (!t) return;
    textInput.value = '';
    sendMessage(t);
  }
});

micBtn.addEventListener('click', () => {
  if (!recognition) return;

  if (currentState === STATE.LISTENING) {
    autoListenActive = false;
    recognition.stop();
    stateSublabel.textContent = 'Voice control deactivated. Click mic to resume.';
  } else {
    autoListenActive = true;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    try {
      recognition.start();
      stateSublabel.textContent = 'Voice control active. Listening...';
    } catch {}
  }
});

clearBtn.addEventListener('click', () => {
  conversation.innerHTML = '';
  appendMessage('system', 'Conversation cleared.');
});

if (autonomousToggle) {
  autonomousToggle.addEventListener('change', (e) => {
    const isAutonomous = e.target.checked;
    if (toggleWrap) toggleWrap.classList.toggle('active', isAutonomous);
    if (toggleLabel) toggleLabel.textContent = isAutonomous ? 'AUTO OVERRIDE [ON]' : 'AUTO OVERRIDE';

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'set_mode',
        autonomous: isAutonomous,
      }));
    }

    appendMessage(
      'system',
      `Autonomous Override ${isAutonomous ? 'ACTIVATED. Desktop & terminal operator actions will execute without pending approvals.' : 'DEACTIVATED. Standard supervision reinstated.'}`
    );
  });
}

// Load voices on Safari/Chrome (async)
if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => {};
}

let interactionActivated = false;
window.addEventListener('click', () => {
  if (!interactionActivated) {
    interactionActivated = true;
    if (autoListenActive && recognition && currentState === STATE.IDLE) {
      try {
        recognition.start();
        stateSublabel.textContent = 'Voice control active. Listening...';
      } catch {}
    }
  }
});

// ── Model Provider Controller ─────────────────────────────────
function updateSecondaryVisibility(provider) {
  if (secOllama) secOllama.style.display = provider === 'ollama' ? 'flex' : 'none';
  if (secLMStudio) secLMStudio.style.display = provider === 'lmstudio' ? 'flex' : 'none';
  if (secApiKey) secApiKey.style.display = provider === 'api_key' ? 'flex' : 'none';
  if (secCustomUrl) secCustomUrl.style.display = provider === 'custom_url' ? 'flex' : 'none';
  updateActiveModelBadge();
}

function updateActiveModelBadge() {
  if (!modelNameDisplay) return;
  const p = providerConfig.provider;
  if (p === 'ollama') {
    modelNameDisplay.textContent = providerConfig.ollamaModel || 'llava:latest';
  } else if (p === 'lmstudio') {
    modelNameDisplay.textContent = providerConfig.lmstudioModel || 'local-model';
  } else if (p === 'api_key') {
    modelNameDisplay.textContent = providerConfig.apiModel || 'gemini-3.6-flash';
  } else if (p === 'custom_url') {
    try {
      const url = new URL(providerConfig.customUrl || 'http://localhost:8000');
      modelNameDisplay.textContent = `Custom (${url.host})`;
    } catch {
      modelNameDisplay.textContent = 'Custom URL';
    }
  }
}

let fetchingOllama = false;
async function fetchOllamaModels() {
  if (fetchingOllama || !ollamaModelSelect) return;
  fetchingOllama = true;
  if (refreshOllamaBtn) refreshOllamaBtn.disabled = true;

  try {
    const res = await fetch('/api/models/ollama');
    if (res.ok) {
      const data = await res.json();
      if (data.models && data.models.length > 0) {
        ollamaModelSelect.innerHTML = '';
        data.models.forEach((m) => {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.name;
          ollamaModelSelect.appendChild(opt);
        });

        if (providerConfig.ollamaModel && data.models.some((m) => m.id === providerConfig.ollamaModel)) {
          ollamaModelSelect.value = providerConfig.ollamaModel;
        } else {
          providerConfig.ollamaModel = ollamaModelSelect.value;
          saveStoredModelConfig(providerConfig);
        }
      } else {
        ollamaModelSelect.innerHTML = '<option value="llava:latest">llava:latest (default)</option>';
      }
    }
  } catch (err) {
    console.warn('Failed to fetch Ollama models:', err);
  } finally {
    fetchingOllama = false;
    if (refreshOllamaBtn) refreshOllamaBtn.disabled = false;
    updateActiveModelBadge();
  }
}

let fetchingLMStudio = false;
async function fetchLMStudioModels() {
  if (fetchingLMStudio || !lmstudioModelSelect) return;
  fetchingLMStudio = true;
  if (refreshLMStudioBtn) refreshLMStudioBtn.disabled = true;

  try {
    const res = await fetch('/api/models/lmstudio');
    if (res.ok) {
      const data = await res.json();
      if (data.models && data.models.length > 0) {
        lmstudioModelSelect.innerHTML = '';
        data.models.forEach((m) => {
          const opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.name;
          lmstudioModelSelect.appendChild(opt);
        });

        if (providerConfig.lmstudioModel && data.models.some((m) => m.id === providerConfig.lmstudioModel)) {
          lmstudioModelSelect.value = providerConfig.lmstudioModel;
        } else {
          providerConfig.lmstudioModel = lmstudioModelSelect.value;
          saveStoredModelConfig(providerConfig);
        }
      } else {
        lmstudioModelSelect.innerHTML = '<option value="local-model">local-model (default)</option>';
      }
    }
  } catch (err) {
    console.warn('Failed to fetch LM Studio models:', err);
  } finally {
    fetchingLMStudio = false;
    if (refreshLMStudioBtn) refreshLMStudioBtn.disabled = false;
    updateActiveModelBadge();
  }
}

async function dispatchProviderChange() {
  saveStoredModelConfig(providerConfig);
  updateActiveModelBadge();

  let targetModel = '';
  if (providerConfig.provider === 'ollama') targetModel = providerConfig.ollamaModel || 'llava:latest';
  else if (providerConfig.provider === 'lmstudio') targetModel = providerConfig.lmstudioModel || 'local-model';
  else if (providerConfig.provider === 'api_key') targetModel = 'gemini-3.6-flash';
  else if (providerConfig.provider === 'custom_url') targetModel = 'custom-model';

  const payload = {
    provider: providerConfig.provider,
    model: targetModel,
    apiKey: providerConfig.apiKey,
    customUrl: providerConfig.customUrl,
  };

  // Sync via WebSocket
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'set_provider', ...payload }));
  }

  // Sync via HTTP API
  try {
    await fetch('/api/models/set-provider', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {}
}

function initModelProviderControls() {
  if (!providerSelect) return;

  // Restore stored values
  providerSelect.value = providerConfig.provider || 'ollama';
  if (apiKeyInput && providerConfig.apiKey) apiKeyInput.value = providerConfig.apiKey;
  if (customUrlInput && providerConfig.customUrl) customUrlInput.value = providerConfig.customUrl;

  updateSecondaryVisibility(providerConfig.provider);

  if (providerConfig.provider === 'ollama') {
    fetchOllamaModels();
  } else if (providerConfig.provider === 'lmstudio') {
    fetchLMStudioModels();
  }

  // Event Listeners
  providerSelect.addEventListener('change', () => {
    providerConfig.provider = providerSelect.value;
    updateSecondaryVisibility(providerConfig.provider);

    if (providerConfig.provider === 'ollama') {
      fetchOllamaModels();
    } else if (providerConfig.provider === 'lmstudio') {
      fetchLMStudioModels();
    }

    dispatchProviderChange();
    appendMessage('system', `Provider switched to ${providerSelect.options[providerSelect.selectedIndex].text}`);
  });

  if (ollamaModelSelect) {
    ollamaModelSelect.addEventListener('change', () => {
      providerConfig.ollamaModel = ollamaModelSelect.value;
      dispatchProviderChange();
    });
  }

  if (refreshOllamaBtn) {
    refreshOllamaBtn.addEventListener('click', () => fetchOllamaModels());
  }

  if (lmstudioModelSelect) {
    lmstudioModelSelect.addEventListener('change', () => {
      providerConfig.lmstudioModel = lmstudioModelSelect.value;
      dispatchProviderChange();
    });
  }

  if (refreshLMStudioBtn) {
    refreshLMStudioBtn.addEventListener('click', () => fetchLMStudioModels());
  }

  if (toggleKeyVisBtn && apiKeyInput) {
    toggleKeyVisBtn.addEventListener('click', () => {
      const isPassword = apiKeyInput.type === 'password';
      apiKeyInput.type = isPassword ? 'text' : 'password';
      toggleKeyVisBtn.textContent = isPassword ? 'HIDE' : 'SHOW';
    });
  }

  if (verifyKeyBtn && apiKeyInput) {
    verifyKeyBtn.addEventListener('click', async () => {
      const key = apiKeyInput.value.trim();
      if (!key) {
        appendMessage('error', 'Please enter an API key to verify.');
        return;
      }
      if (keyStatusIndicator) keyStatusIndicator.className = 'key-status-indicator verifying';
      verifyKeyBtn.disabled = true;

      try {
        const res = await fetch('/api/models/validate-key', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: 'gemini', apiKey: key }),
        });
        const data = await res.json();
        if (data.valid) {
          if (keyStatusIndicator) keyStatusIndicator.className = 'key-status-indicator valid';
          appendMessage('system', 'Google Generative AI (Gemini) API key verified successfully.');
          providerConfig.apiKey = key;
          dispatchProviderChange();
        } else {
          if (keyStatusIndicator) keyStatusIndicator.className = 'key-status-indicator invalid';
          appendMessage('error', `API Key verification failed: ${data.error || 'Invalid credentials'}`);
        }
      } catch (err) {
        if (keyStatusIndicator) keyStatusIndicator.className = 'key-status-indicator invalid';
        appendMessage('error', `Verification request error: ${err.message}`);
      } finally {
        verifyKeyBtn.disabled = false;
      }
    });
  }

  if (applyCustomUrlBtn && customUrlInput) {
    applyCustomUrlBtn.addEventListener('click', () => {
      const url = customUrlInput.value.trim();
      if (!url) return;
      providerConfig.customUrl = url;
      dispatchProviderChange();
      appendMessage('system', `Custom endpoint set to ${url}`);
    });
  }
}

// ── Init ──────────────────────────────────────────────────────
initSpeechRecognition();
initModelProviderControls();
connectWS();
