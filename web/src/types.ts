export type Conversation = {
  id: string;
  shopId: string | null;
  shopName: string | null;
  platform: string | null;
  buyerName: string | null;
  buyerId: string | null;
  avatar: string | null;
  shopLogo?: string | null;
  lastText: string;
  lastAt: number | null;
  unread: number;
  awaiting: boolean;
  tagIds: string[];
  groupId: string | null;
  aiPaused: boolean;
  note: string | null;
};

export type MessageFrom = 'customer' | 'me' | 'staff' | 'platform-bot' | 'ai' | 'ui';

export type Message = {
  id: string;
  from: MessageFrom;
  sender: string | null;
  avatar?: string | null;
  type: string;
  kind: 'text' | 'image' | 'video' | 'product' | 'order' | 'other';
  time: number | null;
  text: string | null;
  translated?: string | null;
  image: string | null;
  url?: string | null;
  aiReplyId?: string;
  failed?: boolean;
  failReason?: string | null;
  sendStatus?: string | null;
  card: null | {
    title?: string; price?: string | number | null; currency?: string | null; image?: string | null;
    itemId?: string | null; url?: string | null; option?: string | null;
    orderId?: string | null; total?: string | number | null; status?: string | null;
  };
};

export type AiReply = {
  id: string;
  conversationId: string;
  shopId: string | null;
  shopName: string | null;
  platform: string | null;
  buyerName: string | null;
  questionId: string | null;
  question: string | null;
  reply: string | null;
  status: string;
  reason: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  reviewed: boolean;
  rating: 'good' | 'bad' | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
};

export type Tag = { id: string; name: string; color: string };
export type Shop = { id: string; name: string; platform: string; logo?: string | null };

export type QuickReply = {
  id: string; title: string; text: string; shortcut: string | null; sortOrder: number; useCount: number;
};

export type Order = {
  orderNumber: string; status: string; createdAt: number | null; amount: number | string | null; currency: string | null;
  paidAt: number | null; paymentMethod: string | null; buyerNote: string | null;
  products: { name: string; option: string | null; sku: string | null; quantity: number; price: number | string; image: string | null; itemId?: string | null; url?: string | null }[];
  logistics: { name: string | null; tracking: string[] } | null;
};

export type Product = {
  itemId: string; name: string; image: string | null; minPrice: number | string; maxPrice: number | string;
  currency: string; stock: number; status: string; url: string | null; sku: string | null;
};

export type CatalogHit = {
  itemId: string; name: string; category: string; sub: string; brand: string; options: string; detail: string | null;
};

export type BotEvent = {
  id: string; event: string; conversationId: string | null; shopName: string | null; buyer: string | null;
  payload: Record<string, unknown>; createdAt: string;
};

export type Status = {
  duoke: { state: string; error: string | null; account: string | null; shops: Shop[] };
  db: { enabled: boolean; ok: boolean; error: string | null };
  ai: { enabled: boolean; autoSend: boolean; provider: string; model: string; knowledgeFiles: number };
  bot: BotEvent | null;
  passwordRequired: boolean;
  brand?: { name: string; logo: string | null };
};

export type Stats = {
  daily: { day: string; status: string; n: number }[];
  today: Record<string, number>;
  staffToday: number;
  messagesToday: number;
  unreviewed: number;
  bad: number;
};

export type KnowledgeFile = { path: string; folder: string; name: string; size: number; updatedAt: number };

export type ShopSummary = { id: string; name: string; platform: string; logo?: string | null; unread: number; awaiting: number };
export type InboxSummary = {
  shops: ShopSummary[]; unread: number; awaiting: number; total: number;
  aiToday: number | null; staffToday: number | null;
};

export type Profile = {
  orders: number; completed: number; spent: number; currency: string; cancelled: number;
  firstOrderAt: number | null; lastOrderAt: number | null;
  aiCount: number | null; staffCount: number | null; firstSeen: string | null;
};

export type OrderDetail = {
  orderNumber: string; status: string | null; currency: string;
  items: { itemId: string | null; name: string; option: string | null; sku: string | null; quantity: number;
    price: number | string | null; originalPrice: number | string | null; image: string | null; url: string | null }[];
  groups: { title: string; fields: { key: string; name: string; label: string | null; value: string | number | boolean }[] }[];
};
