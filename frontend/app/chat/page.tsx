import { catalogIndexReady, listVendors } from '@/lib/catalog';
import { ChatPanel } from '@/components/chat/chat-panel';

export const dynamic = 'force-dynamic';

export default function ChatPage() {
  // The live shelf, so a catalog citation only links to a vendor that exists.
  const vendorFolders = catalogIndexReady() ? listVendors().map((vendor) => vendor.folder) : [];
  return <ChatPanel vendorFolders={vendorFolders} />;
}
