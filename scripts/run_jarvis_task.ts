/**
 * run_jarvis_task.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Opens Jarvis at http://localhost:3000 in a VISIBLE Chrome window,
 * switches the provider to "API Key" (Gemini), enters the key, verifies it,
 * then sends the YouTube task command.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { chromium } from 'playwright';

const GEMINI_API_KEY = 'AIzaSyCTHFXQHFsETluAIqG7W2fc0cbaFGveRWo';
const JARVIS_URL = 'http://localhost:3000';
const TASK_MESSAGE = 'Open Chrome, select Legacy_AS account, go to YouTube and play the latest song by Alan Walker and Ava Max';

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  JARVIS TASK RUNNER — Starting browser automation   ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // Launch a visible (headed) browser so you can watch in real-time
  const browser = await chromium.launch({
    headless: false,
    slowMo: 150,
    args: ['--start-maximized', '--no-sandbox'],
  });

  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  // STEP 1: Navigate to Jarvis
  console.log('→ [Step 1] Opening Jarvis at', JARVIS_URL);
  await page.goto(JARVIS_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await sleep(2500);

  const title = await page.title();
  console.log('   Page title:', title);
  console.log('   ✓ Jarvis UI loaded');

  // STEP 2: Select "API Key" as the provider
  console.log('\n→ [Step 2] Selecting "API Key" provider...');
  const providerSelect = page.locator('#provider-select');
  await providerSelect.waitFor({ state: 'visible', timeout: 8000 });
  await providerSelect.selectOption('api_key');
  await sleep(1000);
  console.log('   ✓ Provider switched to API Key');

  // STEP 3: Enter the Gemini API key
  console.log('\n→ [Step 3] Entering Gemini API key...');
  const apiKeyInput = page.locator('#api-key-input');
  await apiKeyInput.waitFor({ state: 'visible', timeout: 8000 });
  await apiKeyInput.click();
  await apiKeyInput.fill(GEMINI_API_KEY);
  await sleep(500);
  console.log('   ✓ API key entered');

  // STEP 4: Click VERIFY button
  console.log('\n→ [Step 4] Clicking VERIFY button...');
  const verifyBtn = page.locator('#verify-key-btn');
  await verifyBtn.waitFor({ state: 'visible', timeout: 5000 });
  await verifyBtn.click();
  await sleep(3500);
  console.log('   ✓ VERIFY clicked — checking for response...');

  const convMessages = await page.locator('.msg').allTextContents();
  if (convMessages.length > 0) {
    console.log('   Messages so far:');
    convMessages.forEach(m => console.log('     »', m.trim()));
  }

  // STEP 5: Send the task message
  console.log('\n→ [Step 5] Sending task to Jarvis...');
  console.log('   Task:', TASK_MESSAGE);

  const textInput = page.locator('#text-input');
  await textInput.waitFor({ state: 'visible', timeout: 8000 });
  await textInput.click();
  await textInput.fill(TASK_MESSAGE);
  await sleep(500);
  await textInput.press('Enter');
  console.log('   ✓ Task sent! Waiting for Jarvis response...\n');

  // STEP 6: Poll for response
  console.log('─'.repeat(54));
  console.log('JARVIS RESPONSE (streaming):');
  console.log('─'.repeat(54));

  let lastMessageCount = 0;
  const maxPolls = 80; // ~2 minutes
  const pollInterval = 1500;

  for (let poll = 0; poll < maxPolls; poll++) {
    await sleep(pollInterval);

    const allMsgs = await page.locator('.msg').allTextContents();
    if (allMsgs.length > lastMessageCount) {
      for (let i = lastMessageCount; i < allMsgs.length; i++) {
        const msg = allMsgs[i].trim();
        if (msg) console.log(msg);
      }
      lastMessageCount = allMsgs.length;
    }

    const stateReadout = await page.locator('#state-readout').textContent();
    const sublabel = await page.locator('#state-sublabel').textContent();

    if (poll % 8 === 0) {
      console.log(`\n   [State: ${stateReadout} — ${sublabel}]`);
    }

    if (stateReadout === 'IDLE' && poll > 3) {
      console.log('\n─'.repeat(54));
      console.log('✓ Jarvis finished responding (state: IDLE)');
      break;
    }
  }

  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  COMPLETE — Browser stays open for you to review    ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  await sleep(600_000); // Keep open 10 min
  await browser.close();
}

main().catch(err => {
  console.error('\n✗ Error:', err.message);
  process.exit(1);
});
