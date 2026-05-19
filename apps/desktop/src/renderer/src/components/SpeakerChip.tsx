import { useMemo } from 'react'

const palette = [
  'bg-emerald-500/20 text-emerald-300 ring-emerald-500/40',
  'bg-sky-500/20 text-sky-300 ring-sky-500/40',
  'bg-amber-500/20 text-amber-300 ring-amber-500/40',
  'bg-fuchsia-500/20 text-fuchsia-300 ring-fuchsia-500/40',
  'bg-rose-500/20 text-rose-300 ring-rose-500/40',
  'bg-violet-500/20 text-violet-300 ring-violet-500/40',
  'bg-teal-500/20 text-teal-300 ring-teal-500/40'
]

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h)
}

export default function SpeakerChip({
  speaker,
  alias,
  size = 'sm'
}: {
  speaker: string
  alias?: string
  size?: 'sm' | 'md'
}) {
  const isYou = speaker === 'You'
  const display = alias?.trim() || speaker
  const color = useMemo(() => {
    if (isYou) return 'bg-blue-500/20 text-blue-300 ring-blue-500/40'
    return palette[hash(speaker) % palette.length]
  }, [speaker, isYou])
  const padding = size === 'md' ? 'px-2.5 py-1 text-sm' : 'px-2 py-0.5 text-xs'
  return (
    <span className={`inline-flex items-center rounded-full ring-1 ${color} ${padding}`}>
      {display}
    </span>
  )
}
