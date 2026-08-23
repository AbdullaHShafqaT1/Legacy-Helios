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
const autoListenActive = true;

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
    stateSublabel.textContent = 'Jarvis online. Say something.';
    if (autoListenActive && recognition) {
      setTimeout(() => {
        try { recognition.start(); } catch {}
      }, 1000);
    }
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

// ── Text-to-speech (browser native) ──────────────────────────
function speakText(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);

  // Pick a clear voice if available
  const voices  = window.speechSynthesis.getVoices();
  const desired = voices.find(v =>
    v.name.includes('Google UK English Male') ||
    v.name.includes('David')                   ||
    v.name.includes('Daniel')
  );
  if (desired) utt.voice = desired;

  utt.rate   = 1.0;
  utt.pitch  = 0.9;
  utt.volume = 1.0;
  utt.onstart = () => setState(STATE.SPEAKING);
  utt.onend   = () => {
    if (!speaking) setState(STATE.IDLE);
    if (autoListenActive && recognition) {
      setTimeout(() => {
        try { recognition.start(); } catch {}
      }, 400);
    }
  };
  window.speechSynthesis.speak(utt);
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
    recognition.stop();
  } else {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    try { recognition.start(); } catch {}
  }
});

clearBtn.addEventListener('click', () => {
  conversation.innerHTML = '';
  appendMessage('system', 'Conversation cleared.');
});

// Load voices on Safari/Chrome (async)
if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => {};
}

// ── Init ──────────────────────────────────────────────────────
initSpeechRecognition();
connectWS();
