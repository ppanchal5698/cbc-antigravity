import { catalogIndexReady, listVendors } from '@/lib/catalog';
import { ChatPanel } from '@/components/chat/chat-panel';
import { PageHeader } from '@/components/shell/page-header';

export const dynamic = 'force-dynamic';

export default function ChatPage() {
  const vendorFolders = catalogIndexReady() ? listVendors().map((vendor) => vendor.folder) : [];

  return (
    <div className="page-enter flex min-h-0 flex-1 flex-col">
      <div className="mx-auto w-full max-w-[1600px] px-4 sm:px-6">
        <PageHeader
          className="pb-3"
          eyebrow="Workspace companion"
          title="Chat"
        />
        <p className="text-ink-muted max-w-prose pb-4 text-[13px] leading-relaxed">
          Full-width copilot for the whole desk. For a bid set or vendor, open the companion on
          that page — it keeps context tighter.
        </p>
      </div>
      <ChatPanel vendorFolders={vendorFolders} />
    </div>
  );
}
