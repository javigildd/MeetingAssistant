import { BrowserWindow, screen } from 'electron'
import path from 'node:path'

/**
 * Floating frameless mini window (Granola-style) that pops up in the corner
 * of the screen when a call is detected. Shows the platform, the detected
 * caller / topic, and a big "Record" button.
 *
 * Created once at app start and hidden by default. show()/hide() toggle
 * visibility; positioning follows the current display.
 */
export class OverlayWindow {
  private window: BrowserWindow | null = null

  ensureCreated(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window

    const w = new BrowserWindow({
      width: 380,
      height: 84,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      fullscreenable: false,
      // Don't take focus from the foreground app.
      focusable: false,
      // Visible on all macOS spaces / Mission Control.
      vibrancy: undefined,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      },
      titleBarStyle: 'hidden'
    })

    // Keep above everything, including fullscreen apps.
    w.setAlwaysOnTop(true, 'floating', 1)
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) {
      w.loadURL(`${devUrl}/overlay.html`)
    } else {
      w.loadFile(path.join(__dirname, '../renderer/overlay.html'))
    }

    w.on('closed', () => {
      this.window = null
    })

    this.window = w
    this.positionTopRight()
    return w
  }

  private positionTopRight(): void {
    if (!this.window) return
    const display = screen.getPrimaryDisplay()
    const { workArea } = display
    const [w, h] = this.window.getSize()
    // 16px from top, 16px from right
    const x = workArea.x + workArea.width - w - 16
    const y = workArea.y + 16
    this.window.setPosition(Math.round(x), Math.round(y))
  }

  show(): void {
    const w = this.ensureCreated()
    if (!w.isVisible()) {
      this.positionTopRight()
      w.showInactive() // showInactive keeps focus on the meeting app
    }
  }

  hide(): void {
    if (this.window && !this.window.isDestroyed() && this.window.isVisible()) {
      this.window.hide()
    }
  }

  destroy(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy()
    }
    this.window = null
  }
}
