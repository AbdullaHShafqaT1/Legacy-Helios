/**
 * Phase 12 — Service Installer Tests
 *
 * Tests the Task Scheduler XML security validation (key Phase 12 requirement)
 * and the service installer contract without spawning real OS processes.
 *
 * Section 4 / Session-0 verification:
 * The Windows Task Scheduler XML must contain BOTH:
 *   <LogonType>InteractiveToken</LogonType>
 *   <RunOnlyIfLoggedOn>true</RunOnlyIfLoggedOn>
 *
 * These two fields prevent Jarvis from running in Session 0, which would silently
 * disable the Phase 11 override safety hook (WH_KEYBOARD_LL/WH_MOUSE_LL).
 * The validateWindowsTaskXml() function is the programmatic enforcement of this requirement.
 *
 * PARTIAL rating note: the actual `schtasks /Create` import on a live Windows session
 * cannot be automated in CI. The unit tests validate XML structure and the
 * validateWindowsTaskXml() security guard. Live schtasks execution is documented
 * as a manual verification step.
 */

import { describe, it, expect } from 'vitest';
import { validateWindowsTaskXml, WindowsServiceInstaller } from '../../services/ServiceInstaller.js';

describe('ServiceInstaller — Task Scheduler XML security validation (Section 4)', () => {
  it('passes validation for a correctly formed XML with both interactive-session guards', () => {
    const validXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task>
  <Principals>
    <Principal>
      <LogonType>InteractiveToken</LogonType>
    </Principal>
  </Principals>
  <Settings>
    <RunOnlyIfLoggedOn>true</RunOnlyIfLoggedOn>
  </Settings>
</Task>`;
    expect(() => validateWindowsTaskXml(validXml)).not.toThrow();
  });

  it('FAILS validation when LogonType is not InteractiveToken', () => {
    const badXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task>
  <Principals>
    <Principal>
      <LogonType>Password</LogonType>
    </Principal>
  </Principals>
  <Settings>
    <RunOnlyIfLoggedOn>true</RunOnlyIfLoggedOn>
  </Settings>
</Task>`;
    // Password logon type enables Session-0 execution — MUST be rejected
    expect(() => validateWindowsTaskXml(badXml)).toThrow(/InteractiveToken/);
    expect(() => validateWindowsTaskXml(badXml)).toThrow(/SECURITY VIOLATION/);
  });

  it('FAILS validation when RunOnlyIfLoggedOn is false', () => {
    const badXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task>
  <Principals>
    <Principal>
      <LogonType>InteractiveToken</LogonType>
    </Principal>
  </Principals>
  <Settings>
    <RunOnlyIfLoggedOn>false</RunOnlyIfLoggedOn>
  </Settings>
</Task>`;
    expect(() => validateWindowsTaskXml(badXml)).toThrow(/RunOnlyIfLoggedOn/);
    expect(() => validateWindowsTaskXml(badXml)).toThrow(/SECURITY VIOLATION/);
  });

  it('FAILS validation when RunOnlyIfLoggedOn is missing entirely', () => {
    const badXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task>
  <Principals>
    <Principal>
      <LogonType>InteractiveToken</LogonType>
    </Principal>
  </Principals>
  <Settings></Settings>
</Task>`;
    expect(() => validateWindowsTaskXml(badXml)).toThrow(/RunOnlyIfLoggedOn/);
  });

  it('FAILS validation when both security fields are missing', () => {
    const emptyXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task><Settings></Settings></Task>`;
    expect(() => validateWindowsTaskXml(emptyXml)).toThrow(/InteractiveToken/);
  });
});

describe('ServiceInstaller — WindowsServiceInstaller XML generation', () => {
  it('generateXml() produces XML that passes the security validator', () => {
    const installer = new WindowsServiceInstaller('node.exe', 'C:\\jarvis');
    const xml = installer.generateXml();

    // Must contain both required security fields
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).toContain('<RunOnlyIfLoggedOn>true</RunOnlyIfLoggedOn>');

    // Must NOT contain Password logon type
    expect(xml).not.toContain('<LogonType>Password</LogonType>');

    // Security validator must also pass (belt-and-suspenders)
    expect(() => validateWindowsTaskXml(xml)).not.toThrow();
  });

  it('generateXml() embeds the provided execPath and workingDir', () => {
    const installer = new WindowsServiceInstaller('C:\\node\\node.exe', 'C:\\jarvis\\project');
    const xml = installer.generateXml();
    expect(xml).toContain('C:\\node\\node.exe');
    expect(xml).toContain('C:\\jarvis\\project');
  });

  it('generateXml() includes an explanatory comment about Session-0 risk', () => {
    const installer = new WindowsServiceInstaller('node.exe', 'C:\\jarvis');
    const xml = installer.generateXml();
    // The comment explains WHY InteractiveToken is required
    expect(xml).toContain('WH_KEYBOARD_LL');
    expect(xml).toContain('Session 0');
  });

  it('isInstalled() returns false on non-Windows platform (unit-safe)', async () => {
    const installer = new WindowsServiceInstaller('node.exe', process.cwd());
    if (process.platform !== 'win32') {
      // On Linux/macOS, this should return false without crashing
      const installed = await installer.isInstalled();
      expect(installed).toBe(false);
    } else {
      // On Windows, it makes a real schtasks call — just verify it returns a boolean
      const installed = await installer.isInstalled();
      expect(typeof installed).toBe('boolean');
    }
  });
});

describe('ServiceInstaller — getPlatformInstaller', () => {
  it('returns the appropriate installer type for the current platform', async () => {
    const { getPlatformInstaller } = await import('../../services/ServiceInstaller.js');
    const platform = process.platform;
    if (platform === 'win32' || platform === 'linux' || platform === 'darwin') {
      const installer = getPlatformInstaller('node', process.cwd());
      expect(installer).toBeTruthy();
    }
  });

  it('throws for unsupported platforms', async () => {
    const { getPlatformInstaller } = await import('../../services/ServiceInstaller.js');
    // Temporarily mock process.platform
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true });
    try {
      expect(() => getPlatformInstaller('node', process.cwd())).toThrow(/not supported/);
    } finally {
      if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    }
  });
});

/**
 * MANUAL VERIFICATION PROCEDURE — Section 4
 *
 * The following cannot be automated in CI because `schtasks /Create` requires
 * an interactive Windows session with appropriate privileges.
 *
 * To manually verify the Session-0 autostart configuration:
 *
 * 1. Run `jarvis service install` on a Windows machine logged in as a normal user.
 * 2. Open Task Scheduler (taskschd.msc).
 * 3. Locate the "JarvisOS" task in the task library.
 * 4. Open Properties → General tab.
 * 5. Verify:
 *    - "Run only when user is logged on" radio button IS selected.
 *    - "Run whether user is logged on or not" IS NOT selected.
 *    - "Run with highest privileges" IS NOT checked.
 * 6. Open Properties → XML tab. Confirm:
 *    - <LogonType>InteractiveToken</LogonType> is present.
 *    - <RunOnlyIfLoggedOn>true</RunOnlyIfLoggedOn> is present.
 * 7. To verify Session-0 protection: attempt to change the task to "Run whether user
 *    is logged on or not." This should require a password prompt. If Jarvis's override
 *    hook (jarvis health → check 'override' subsystem) reports FAILED after a non-
 *    interactive log-on attempt, the fail-closed guard is working correctly.
 * 8. Run `jarvis service uninstall` and confirm the task is removed from Task Scheduler.
 */
