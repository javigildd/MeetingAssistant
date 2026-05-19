import { Notification, BrowserWindow, app } from 'electron'
import type { DetectedCall } from '../shared/types'

const PLATFORM_LABEL: Record<DetectedCall['platform'], string> = {
  'slack-huddle': 'Slack Huddle',
  zoom: 'Zoom',
  'google-meet': 'Google Meet',
  whatsapp: 'WhatsApp call',
  teams: 'Microsoft Teams',
  facetime: 'FaceTime',
  webex: 'Webex',
  unknown: 'Meeting'
}

export interface CallNotificationHandlers {
  /** Fired when the user clicks the notification body or the Record action. */
  onRecord: (call: DetectedCall) => void
}

/**
 * Show a native macOS notification about a detected call. The user can click
 * the notification (or its Record action on supported macOS versions) to
 * immediately start recording it.
 */
export function notifyCallDetected(call: DetectedCall, handlers: CallNotificationHandlers): void {
  if (!Notification.isSupported()) return

  const platformLabel = PLATFORM_LABEL[call.platform]
  const title = `${platformLabel} detected`
  const body = call.callerLabel
    ? call.callerLabel
    : call.windowTitle || `Tap to record this ${platformLabel}`

  const n = new Notification({
    title,
    body,
    subtitle: 'MeetingAssistant',
    silent: false,
    // Notification actions on macOS show up when the user expands the
    // notification ("Options" / hover). Still useful, but the primary
    // interaction is clicking the body.
    actions: [{ type: 'button', text: 'Record' }],
    closeButtonText: 'Dismiss'
  })

  const trigger = () => {
    focusMainWindow()
    handlers.onRecord(call)
  }

  n.on('click', trigger)
  n.on('action', trigger)

  n.show()
}

function focusMainWindow(): void {
  // Bring the app forward; macOS notifications can fire while the app is
  // hidden, and we want the user to immediately see the recording UI.
  app.focus({ steal: true })
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}
