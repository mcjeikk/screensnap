/**
 * @file ScreenBolt — Permissions Page
 * @description Opens in a tab to request mic/camera permissions.
 * Accepts ?request=microphone or ?request=camera to auto-trigger the right prompt.
 * Once granted, user can close this tab and go back to the popup.
 */
(() => {
  'use strict';

  const resultEl = document.getElementById('result');
  const doneBtn = document.getElementById('btn-done');
  const micBtn = document.getElementById('btn-mic');
  const camBtn = document.getElementById('btn-cam');

  function showResult(msg, ok) {
    resultEl.textContent = msg;
    resultEl.className = ok ? 'result result--ok' : 'result result--fail';
    doneBtn.style.display = 'inline-block';
  }

  async function requestMic() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
      micBtn.textContent = '🎤 Microphone ✅';
      micBtn.disabled = true;
      showResult('✅ Microphone granted! Close this tab and enable the toggle again.', true);
    } catch (err) {
      showResult('❌ Microphone denied: ' + err.message, false);
    }
  }

  async function requestCam() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach(t => t.stop());
      camBtn.textContent = '📷 Camera ✅';
      camBtn.disabled = true;
      showResult('✅ Camera granted! Close this tab and enable the toggle again.', true);
    } catch (err) {
      showResult('❌ Camera denied: ' + err.message, false);
    }
  }

  micBtn.addEventListener('click', requestMic);
  camBtn.addEventListener('click', requestCam);

  doneBtn.addEventListener('click', () => window.close());

  // Check which permissions are already granted and update buttons
  async function checkExisting() {
    try {
      const mic = await navigator.permissions.query({ name: 'microphone' });
      if (mic.state === 'granted') {
        micBtn.textContent = '🎤 Microphone ✅';
        micBtn.disabled = true;
      }
    } catch {}
    try {
      const cam = await navigator.permissions.query({ name: 'camera' });
      if (cam.state === 'granted') {
        camBtn.textContent = '📷 Camera ✅';
        camBtn.disabled = true;
      }
    } catch {}
  }

  checkExisting();

  // Auto-request based on URL param
  const params = new URLSearchParams(window.location.search);
  const request = params.get('request');
  if (request === 'microphone') {
    requestMic();
  } else if (request === 'camera') {
    requestCam();
  }
})();
