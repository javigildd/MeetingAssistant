import { contextBridge, ipcRenderer } from 'electron'
import type {
  Settings,
  Meeting,
  MeetingSummary,
  ChatTurn,
  ChatCitation,
  CapturableWindow
} from '../shared/types'

const api = {
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    save: (partial: Partial<Settings>): Promise<Settings> =>
      ipcRenderer.invoke('settings:save', partial)
  },
  windows: {
    list: (): Promise<CapturableWindow[]> => ipcRenderer.invoke('windows:list')
  },
  meetings: {
    list: (): Promise<MeetingSummary[]> => ipcRenderer.invoke('meetings:list'),
    get: (id: string): Promise<Meeting | null> => ipcRenderer.invoke('meetings:get', id),
    rename: (id: string, title: string): Promise<Meeting | null> =>
      ipcRenderer.invoke('meetings:rename', id, title),
    renameSpeaker: (id: string, original: string, name: string): Promise<Meeting | null> =>
      ipcRenderer.invoke('meetings:renameSpeaker', id, original, name),
    delete: (id: string): Promise<Meeting | null> => ipcRenderer.invoke('meetings:delete', id)
  },
  recording: {
    start: (opts?: { windowId?: number }): Promise<{ meetingId: string; windowId: number | null }> =>
      ipcRenderer.invoke('recording:start', opts),
    stop: (id: string): Promise<any> => ipcRenderer.invoke('recording:stop', id),
    active: (): Promise<string[]> => ipcRenderer.invoke('recording:active')
  },
  chat: {
    ask: (
      history: ChatTurn[],
      q: string,
      meetingId?: string
    ): Promise<{ answer: string; citations: ChatCitation[] }> =>
      ipcRenderer.invoke('chat:ask', history, q, meetingId)
  },
  shell: {
    openFolder: (p: string): Promise<string> => ipcRenderer.invoke('shell:openFolder', p)
  },
  events: {
    onRecorderEvent: (cb: (evt: any) => void) => {
      const fn = (_: unknown, evt: any) => cb(evt)
      ipcRenderer.on('recorder:event', fn)
      return () => ipcRenderer.off('recorder:event', fn)
    },
    onPipelineEvent: (cb: (evt: any) => void) => {
      const fn = (_: unknown, evt: any) => cb(evt)
      ipcRenderer.on('pipeline:event', fn)
      return () => ipcRenderer.off('pipeline:event', fn)
    },
    onMeetingStatus: (cb: (evt: any) => void) => {
      const fn = (_: unknown, evt: any) => cb(evt)
      ipcRenderer.on('meeting:status', fn)
      return () => ipcRenderer.off('meeting:status', fn)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
