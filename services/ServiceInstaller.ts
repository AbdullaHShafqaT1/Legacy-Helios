import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

/**
 * Windows Task Scheduler XML template.
 *
 * CRITICAL SECURITY REQUIREMENT (Phase 12):
 * The generated XML MUST contain:
 *   <LogonType>InteractiveToken</LogonType>      — restricts execution to an interactive user session
 *   <RunOnlyIfLoggedOn>true</RunOnlyIfLoggedOn>  — explicit second guard preventing Session-0 launch
 *
 * Running Jarvis as a Session-0 background service would prevent WH_KEYBOARD_LL / WH_MOUSE_LL
 * global input hooks from installing (Phase 11 OverrideHookConnector), silently defeating the
 * user-override safety gate established in Phase 11.
 *
 * These two fields are the primary security objective of Phase 12.
 */
function buildWindowsTaskXml(execPath: string, workingDir: string, username: string): string {
  const now = new Date().toISOString().split('T')[0];
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Date>${now}</Date>
    <Author>${username}</Author>
    <Description>Jarvis OS — AI Orchestration System. Runs only in an interactive user session to support the Phase 11 low-level input safety hook (WH_KEYBOARD_LL/WH_MOUSE_LL).</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${username}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${username}</UserId>
      <!-- InteractiveToken ensures this task ONLY runs in an interactive user session.
           This is mandatory for Phase 11's WH_KEYBOARD_LL/WH_MOUSE_LL hooks to attach.
           Changing this to Password would cause hooks to silently fail in Session 0. -->
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <!-- RunOnlyIfLoggedOn = true: second explicit guard. Prevents execution if user logs off. -->
    <RunOnlyIfLoggedOn>true</RunOnlyIfLoggedOn>
    <Hidden>false</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${execPath}</Command>
      <WorkingDirectory>${workingDir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
}

const TASK_NAME = 'JarvisOS';

/**
 * Verifies the generated Task Scheduler XML contains both required interactive-session guards.
 * Throws if either is missing — this is a hard security check, not a warning.
 */
export function validateWindowsTaskXml(xml: string): void {
  if (!xml.includes('<LogonType>InteractiveToken</LogonType>')) {
    throw new Error(
      'SECURITY VIOLATION: Generated Task Scheduler XML is missing <LogonType>InteractiveToken</LogonType>. ' +
      'This field is mandatory to prevent Jarvis from running in Session 0 and silently breaking the Phase 11 override hook.'
    );
  }
  if (!xml.includes('<RunOnlyIfLoggedOn>true</RunOnlyIfLoggedOn>')) {
    throw new Error(
      'SECURITY VIOLATION: Generated Task Scheduler XML is missing <RunOnlyIfLoggedOn>true</RunOnlyIfLoggedOn>. ' +
      'This field is a mandatory second guard against Session-0 execution.'
    );
  }
}

export class WindowsServiceInstaller {
  private execPath: string;
  private workingDir: string;

  constructor(execPath: string, workingDir: string) {
    this.execPath = execPath;
    this.workingDir = workingDir;
  }

  async install(): Promise<void> {
    if (process.platform !== 'win32') {
      throw new Error('WindowsServiceInstaller can only be used on Windows.');
    }

    const username = os.userInfo().username;
    const xml = buildWindowsTaskXml(this.execPath, this.workingDir, username);

    // Hard security validation before writing or importing
    validateWindowsTaskXml(xml);

    const tmpXml = path.join(os.tmpdir(), 'jarvis-task-scheduler.xml');
    try {
      // Write as UTF-16LE (Task Scheduler requires it)
      fs.writeFileSync(tmpXml, Buffer.from('\uFEFF' + xml, 'utf16le'));
      execSync(`schtasks /Create /TN "${TASK_NAME}" /XML "${tmpXml}" /F`, { stdio: 'pipe' });
    } catch (err: any) {
      // Clean up partial registration on failure
      try { execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: 'pipe' }); } catch { /* ignore */ }
      throw new Error(`Failed to register Task Scheduler task: ${err?.message || err}`);
    } finally {
      try { fs.unlinkSync(tmpXml); } catch { /* ignore */ }
    }
  }

  async uninstall(): Promise<void> {
    if (process.platform !== 'win32') {
      throw new Error('WindowsServiceInstaller can only be used on Windows.');
    }
    try {
      execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: 'pipe' });
    } catch (err: any) {
      const msg = err?.stderr?.toString() || err?.message || '';
      // "cannot find the file" means it was never installed — treat as success
      if (msg.includes('cannot find the file') || msg.includes('does not exist')) return;
      throw new Error(`Failed to uninstall Task Scheduler task: ${msg}`);
    }
  }

  async isInstalled(): Promise<boolean> {
    if (process.platform !== 'win32') return false;
    try {
      execSync(`schtasks /Query /TN "${TASK_NAME}"`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }

  /** Returns the generated XML for inspection/testing without writing to disk. */
  generateXml(): string {
    const username = os.userInfo().username;
    return buildWindowsTaskXml(this.execPath, this.workingDir, username);
  }
}

const SYSTEMD_UNIT_NAME = 'jarvis.service';

export class LinuxServiceInstaller {
  private execPath: string;
  private workingDir: string;

  constructor(execPath: string, workingDir: string) {
    this.execPath = execPath;
    this.workingDir = workingDir;
  }

  private get unitPath(): string {
    return path.join(os.homedir(), '.config', 'systemd', 'user', SYSTEMD_UNIT_NAME);
  }

  async install(): Promise<void> {
    if (process.platform !== 'linux') {
      throw new Error('LinuxServiceInstaller can only be used on Linux.');
    }

    // Verify systemctl is available
    try {
      execSync('systemctl --version', { stdio: 'pipe' });
    } catch {
      throw new Error(
        'systemctl not found. This environment does not support systemd user services. ' +
        'No partial service registration was left behind.'
      );
    }

    const unitDir = path.dirname(this.unitPath);
    fs.mkdirSync(unitDir, { recursive: true });

    const unit = [
      '[Unit]',
      'Description=Jarvis OS - AI Orchestration System',
      'After=default.target',
      '',
      '[Service]',
      'Type=simple',
      `ExecStart=${this.execPath}`,
      `WorkingDirectory=${this.workingDir}`,
      'Restart=on-failure',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=default.target',
    ].join('\n');

    try {
      fs.writeFileSync(this.unitPath, unit, 'utf8');
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
      execSync(`systemctl --user enable ${SYSTEMD_UNIT_NAME}`, { stdio: 'pipe' });
    } catch (err: any) {
      // Clean up on failure
      try { fs.unlinkSync(this.unitPath); } catch { /* ignore */ }
      throw new Error(`Failed to install systemd user service: ${err?.message || err}`);
    }
  }

  async uninstall(): Promise<void> {
    if (process.platform !== 'linux') {
      throw new Error('LinuxServiceInstaller can only be used on Linux.');
    }
    try {
      execSync(`systemctl --user disable ${SYSTEMD_UNIT_NAME}`, { stdio: 'pipe' });
    } catch { /* not enabled — that's fine */ }
    try {
      if (fs.existsSync(this.unitPath)) fs.unlinkSync(this.unitPath);
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    } catch (err: any) {
      throw new Error(`Failed to uninstall systemd user service: ${err?.message || err}`);
    }
  }

  async isInstalled(): Promise<boolean> {
    if (process.platform !== 'linux') return false;
    return fs.existsSync(this.unitPath);
  }
}

const PLIST_LABEL = 'com.legacy.jarvis';
const PLIST_NAME = `${PLIST_LABEL}.plist`;

export class MacOSServiceInstaller {
  private execPath: string;
  private workingDir: string;

  constructor(execPath: string, workingDir: string) {
    this.execPath = execPath;
    this.workingDir = workingDir;
  }

  private get plistPath(): string {
    return path.join(os.homedir(), 'Library', 'LaunchAgents', PLIST_NAME);
  }

  async install(): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new Error('MacOSServiceInstaller can only be used on macOS.');
    }

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${this.execPath}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${this.workingDir}</string>
  <!-- KeepAlive false: runs once on login, does not restart as a persistent daemon -->
  <key>KeepAlive</key>
  <false/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(os.homedir(), 'Library', 'Logs', 'jarvis.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(os.homedir(), 'Library', 'Logs', 'jarvis-error.log')}</string>
</dict>
</plist>`;

    const plistDir = path.dirname(this.plistPath);
    try {
      fs.mkdirSync(plistDir, { recursive: true });
      fs.writeFileSync(this.plistPath, plist, 'utf8');
      execSync(`launchctl load "${this.plistPath}"`, { stdio: 'pipe' });
    } catch (err: any) {
      // Clean up on failure
      try { if (fs.existsSync(this.plistPath)) fs.unlinkSync(this.plistPath); } catch { /* ignore */ }
      throw new Error(`Failed to install LaunchAgent: ${err?.message || err}`);
    }
  }

  async uninstall(): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new Error('MacOSServiceInstaller can only be used on macOS.');
    }
    if (fs.existsSync(this.plistPath)) {
      try {
        execSync(`launchctl unload "${this.plistPath}"`, { stdio: 'pipe' });
      } catch { /* not loaded — fine */ }
      try {
        fs.unlinkSync(this.plistPath);
      } catch (err: any) {
        throw new Error(`Failed to remove LaunchAgent plist: ${err?.message || err}`);
      }
    }
  }

  async isInstalled(): Promise<boolean> {
    if (process.platform !== 'darwin') return false;
    return fs.existsSync(this.plistPath);
  }
}

/**
 * Returns the platform-appropriate service installer.
 * Throws a clear error for unsupported platforms.
 */
export function getPlatformInstaller(execPath: string, workingDir: string): WindowsServiceInstaller | LinuxServiceInstaller | MacOSServiceInstaller {
  switch (process.platform) {
    case 'win32': return new WindowsServiceInstaller(execPath, workingDir);
    case 'linux': return new LinuxServiceInstaller(execPath, workingDir);
    case 'darwin': return new MacOSServiceInstaller(execPath, workingDir);
    default:
      throw new Error(
        `Platform "${process.platform}" is not supported for autostart service installation. ` +
        `Supported platforms: win32, linux, darwin.`
      );
  }
}
