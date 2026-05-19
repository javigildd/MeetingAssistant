import ChatPanel from '../components/ChatPanel'

export default function ChatPage() {
  return (
    <div className="flex flex-col h-full">
      <div className="px-8 py-4 border-b border-white/5">
        <h1 className="text-xl font-semibold">Chat with your meetings</h1>
        <p className="text-xs text-ink-400 mt-1">
          Asks across every recorded meeting. Answers cite the segments used.
        </p>
      </div>
      <div className="flex-1 overflow-hidden px-8">
        <ChatPanel
          placeholder="Ask anything about your past meetings…"
          hints={[
            'What action items did I get last week?',
            'Did we agree on a release date?',
            'What did Maria say about the budget?'
          ]}
        />
      </div>
    </div>
  )
}
